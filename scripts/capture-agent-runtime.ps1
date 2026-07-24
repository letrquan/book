<#
.SYNOPSIS
Captures a privacy-filtered snapshot of Book managed-agent runtime statistics.

.DESCRIPTION
Writes timestamped Markdown and JSON reports. The reports include persisted agent status,
token and duration totals, telemetry integrity signals, debug-log metadata, and an optional
host process snapshot. Prompts, transcripts, results, evidence bodies, and raw errors are not
copied.

.EXAMPLE
./scripts/capture-agent-runtime.ps1

.EXAMPLE
./scripts/capture-agent-runtime.ps1 -SkipProcesses

.EXAMPLE
./scripts/capture-agent-runtime.ps1 -OutputDirectory C:\temp\book-agent-reports
#>
[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path (Get-Location) '.book/reports'),
  [string]$AgentStoreRoot,
  [switch]$SkipProcesses
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$activeStatuses = @('queued', 'starting', 'running', 'waiting_input', 'waiting_permission')
$terminalEvents = @('complete', 'failed')

if ([string]::IsNullOrWhiteSpace($AgentStoreRoot)) {
  $profileRoot = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($profileRoot)) {
    $profileRoot = [Environment]::GetFolderPath('UserProfile')
  }
  $AgentStoreRoot = Join-Path $profileRoot '.book/agents'
}

function Get-Value {
  param(
    [object]$InputObject,
    [string]$Name,
    [object]$Default = $null
  )

  if ($null -eq $InputObject) {
    return $Default
  }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Default
  }
  return $property.Value
}

function Get-CountMap {
  param(
    [object[]]$Items,
    [scriptblock]$Selector
  )

  $map = [ordered]@{}
  foreach ($item in $Items) {
    $key = & $Selector $item
    if ([string]::IsNullOrWhiteSpace([string]$key)) {
      $key = 'unknown'
    }
    if (-not $map.Contains($key)) {
      $map[$key] = 0
    }
    $map[$key]++
  }
  return $map
}

function Get-ErrorClass {
  param([string]$Message)

  if ([string]::IsNullOrWhiteSpace($Message)) {
    return $null
  }
  if ($Message -match '(?i)413|request entity too large') {
    return 'http_413_request_too_large'
  }
  if ($Message -match '(?i)stream stalled|no data received') {
    return 'stream_stall'
  }
  if ($Message -match '(?i)timeout|timed out') {
    return 'timeout'
  }
  if ($Message -match '(?i)abort|cancel|stop') {
    return 'aborted'
  }
  if ($Message -match '(?i)api error|provider') {
    return 'provider_error'
  }
  return 'other'
}

function Get-RepositoryHash {
  param([string]$Path)

  $normalized = [IO.Path]::GetFullPath($Path).ToLowerInvariant()
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    $digest = $sha.ComputeHash($bytes)
    return ([Convert]::ToHexString($digest).ToLowerInvariant()).Substring(0, 20)
  } finally {
    $sha.Dispose()
  }
}

function Invoke-Git {
  param([string[]]$Arguments)

  $output = & git @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  return ($output -join "`n").Trim()
}

function Add-MarkdownTable {
  param(
    [Collections.Generic.List[string]]$Lines,
    [string[]]$Headers,
    [object[]]$Rows
  )

  $Lines.Add('| ' + ($Headers -join ' | ') + ' |')
  $Lines.Add('| ' + (($Headers | ForEach-Object { '---' }) -join ' | ') + ' |')
  foreach ($row in $Rows) {
    $cells = $row | ForEach-Object {
      ([string]$_).Replace('|', '\|').Replace("`r", ' ').Replace("`n", ' ')
    }
    $Lines.Add('| ' + ($cells -join ' | ') + ' |')
  }
}

function New-MarkdownRow {
  param([object[]]$Cells)

  Write-Output -NoEnumerate $Cells
}

$capturedAt = Get-Date
$repoRoot = Invoke-Git @('rev-parse', '--show-toplevel')
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  $repoRoot = (Get-Location).Path
}
$repoRoot = [IO.Path]::GetFullPath($repoRoot)
$repoHash = Get-RepositoryHash $repoRoot
$head = Invoke-Git @('rev-parse', 'HEAD')
$branch = Invoke-Git @('branch', '--show-current')
$statusOutput = Invoke-Git @('status', '--short')
$statusLines = @(($statusOutput -split "`n") | Where-Object { $_ })

$stores = [Collections.Generic.List[object]]::new()
$agents = [Collections.Generic.List[object]]::new()
$telemetry = [Collections.Generic.List[object]]::new()

if (Test-Path -LiteralPath $AgentStoreRoot) {
  foreach ($directory in Get-ChildItem -LiteralPath $AgentStoreRoot -Directory | Sort-Object Name) {
    $statePath = Join-Path $directory.FullName 'state.json'
    $metricsPath = Join-Path $directory.FullName 'metrics.jsonl'
    if (-not (Test-Path -LiteralPath $statePath)) {
      $stores.Add([pscustomobject]@{
        repoHash = $directory.Name
        hasState = $false
      })
      continue
    }

    try {
      $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } catch {
      $stores.Add([pscustomobject]@{
        repoHash = $directory.Name
        hasState = $true
        parseError = $_.Exception.Message
      })
      continue
    }

    $storeVersion = [int](Get-Value $state 'version' 2)
    if ($storeVersion -ge 3) {
      $recordsPath = Join-Path $directory.FullName 'records'
      $stateAgents = @(
        if (Test-Path -LiteralPath $recordsPath) {
          foreach ($recordFile in Get-ChildItem -LiteralPath $recordsPath -Filter '*.json' -File) {
            try {
              Get-Content -LiteralPath $recordFile.FullName -Raw | ConvertFrom-Json
            } catch {
              # Corrupt record files are quarantined by Book and omitted here.
            }
          }
        }
      )
    } else {
      $stateAgents = @(Get-Value $state 'agents' @())
    }
    $durations = [Collections.Generic.List[long]]::new()
    $storeTokens = [long]0

    foreach ($agent in $stateAgents) {
      $startedAt = Get-Value $agent 'runStartedAt' (Get-Value $agent 'startedAt')
      $finishedAt = Get-Value $agent 'finishedAt'
      $durationMs = $null
      if ($null -ne $startedAt -and $null -ne $finishedAt) {
        $durationMs = [long]$finishedAt - [long]$startedAt
        $durations.Add($durationMs)
      }

      $usage = Get-Value $agent 'usage'
      $tokens = Get-Value $usage 'totalTokens'
      if ($null -ne $tokens) {
        $storeTokens += [long]$tokens
      }

      $activity = Get-Value $agent 'currentActivity'
      $agents.Add([pscustomobject]@{
        repoHash = $directory.Name
        agentId = Get-Value $agent 'id' 'unknown'
        profile = Get-Value $agent 'profile' (Get-Value $agent 'name' 'unknown')
        role = Get-Value $agent 'role' 'unknown'
        status = Get-Value $agent 'status' 'unknown'
        model = Get-Value $agent 'resolvedModel' 'unknown'
        provider = Get-Value $agent 'provider'
        isolation = Get-Value $agent 'isolation' 'unknown'
        totalTokens = $tokens
        createdAt = Get-Value $agent 'createdAt'
        startedAt = $startedAt
        updatedAt = Get-Value $agent 'updatedAt'
        finishedAt = $finishedAt
        durationMs = $durationMs
        activityKind = Get-Value $activity 'kind'
        errorClass = Get-ErrorClass ([string](Get-Value $agent 'error' ''))
      })
    }

    $eventCount = 0
    if (Test-Path -LiteralPath $metricsPath) {
      foreach ($line in Get-Content -LiteralPath $metricsPath) {
        if ([string]::IsNullOrWhiteSpace($line)) {
          continue
        }
        try {
          $event = $line | ConvertFrom-Json
          $telemetry.Add([pscustomobject]@{
            repoHash = $directory.Name
            timestamp = Get-Value $event 'timestamp'
            event = Get-Value $event 'event' 'unknown'
            agentId = Get-Value $event 'agentId'
            role = Get-Value $event 'role'
            status = Get-Value $event 'status'
            route = Get-Value $event 'route'
            issueQuality = Get-Value $event 'issueQuality'
            wallTimeMs = Get-Value $event 'wallTimeMs'
            totalTokens = Get-Value $event 'totalTokens'
            runSequence = Get-Value $event 'runSequence'
            completionSequence = Get-Value $event 'completionSequence'
            toolCalls = Get-Value $event 'toolCalls'
            compactions = Get-Value $event 'compactions'
            retries = Get-Value $event 'retries'
            resultCharacters = Get-Value $event 'resultCharacters'
            errorKind = Get-Value $event 'errorKind'
            applicationStatus = Get-Value $event 'applicationStatus'
          })
          $eventCount++
        } catch {
          $telemetry.Add([pscustomobject]@{
            repoHash = $directory.Name
            event = 'parse_error'
          })
          $eventCount++
        }
      }
    }

    $storeAgents = @($agents | Where-Object { $_.repoHash -eq $directory.Name })
    $stores.Add([pscustomobject]@{
      repoHash = $directory.Name
      hasState = $true
      agentCount = $storeAgents.Count
      activeCount = @($storeAgents | Where-Object { $_.status -in $activeStatuses }).Count
      statusCounts = Get-CountMap $storeAgents { param($item) $item.status }
      roleCounts = Get-CountMap $storeAgents { param($item) $item.role }
      modelCounts = Get-CountMap $storeAgents { param($item) $item.model }
      totalTokens = $storeTokens
      meanDurationMs = if ($durations.Count) {
        [math]::Round(($durations | Measure-Object -Average).Average)
      } else {
        $null
      }
      maxDurationMs = if ($durations.Count) {
        ($durations | Measure-Object -Maximum).Maximum
      } else {
        $null
      }
      metricsEvents = $eventCount
      stateBytes = [long](
        (Get-ChildItem -LiteralPath $directory.FullName -Recurse -Filter '*.json' -File |
          Measure-Object -Property Length -Sum).Sum
      )
      metricsBytes = if (Test-Path -LiteralPath $metricsPath) {
        (Get-Item -LiteralPath $metricsPath).Length
      } else {
        0
      }
      planCount = if ($storeVersion -ge 3) {
        @(Get-ChildItem -LiteralPath (Join-Path $directory.FullName 'plans') -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
      } else { @(Get-Value $state 'plans' @()).Count }
      evidenceCount = if ($storeVersion -ge 3) {
        @(Get-ChildItem -LiteralPath (Join-Path $directory.FullName 'evidence') -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
      } else { @(Get-Value $state 'evidence' @()).Count }
      snapshotCount = if ($storeVersion -ge 3) {
        @(Get-ChildItem -LiteralPath (Join-Path $directory.FullName 'snapshots') -Filter '*.json' -File -ErrorAction SilentlyContinue).Count
      } else { @(Get-Value $state 'snapshots' @()).Count }
    })
  }
}

$allAgents = @($agents)
$activeAgents = @($allAgents | Where-Object { $_.status -in $activeStatuses })
$completedAgents = @($allAgents | Where-Object status -eq 'completed')
$failedAgents = @($allAgents | Where-Object status -eq 'failed')
$interruptedAgents = @($allAgents | Where-Object status -eq 'interrupted')
$tokenValues = @($allAgents | ForEach-Object {
  if ($null -ne $_.totalTokens) {
    [long]$_.totalTokens
  }
})
$totalTokens = if ($tokenValues.Count) {
  [long](($tokenValues | Measure-Object -Sum).Sum)
} else {
  [long]0
}
$telemetryEvents = @($telemetry)
$eventCounts = Get-CountMap $telemetryEvents { param($item) $item.event }
$errorCounts = Get-CountMap @($allAgents | Where-Object errorClass) {
  param($item) $item.errorClass
}

$duplicateTerminalEvents = 0
$terminalTelemetry = @($telemetryEvents | Where-Object {
  $_.event -in $terminalEvents -and -not [string]::IsNullOrWhiteSpace([string]$_.agentId)
})
foreach ($group in $terminalTelemetry | Group-Object {
  '{0}|{1}|{2}|{3}' -f $_.repoHash, $_.agentId, $_.event, (Get-Value $_ 'runSequence' 'legacy')
}) {
  if ($group.Count -gt 1) {
    $duplicateTerminalEvents += $group.Count - 1
  }
}

$debugLogPath = Join-Path $repoRoot '.book/debug.log'
$debugLog = $null
if (Test-Path -LiteralPath $debugLogPath) {
  $lastUsage = $null
  $lastDurationMs = $null
  $lastTokenCount = $null
  foreach ($line in Get-Content -LiteralPath $debugLogPath -Tail 5000) {
    if ($line -match 'stream done.*"promptTokens":(\d+),"completionTokens":(\d+),"totalTokens":(\d+)') {
      $lastUsage = [pscustomobject]@{
        promptTokens = [long]$Matches[1]
        completionTokens = [long]$Matches[2]
        totalTokens = [long]$Matches[3]
      }
    }
    if ($line -match 'agent done.*"durationMs":(\d+)') {
      $lastDurationMs = [long]$Matches[1]
    }
    if ($line -match 'statusline.*tokenCount=(\d+)') {
      $lastTokenCount = [long]$Matches[1]
    }
  }
  $debugFile = Get-Item -LiteralPath $debugLogPath
  $debugLog = [pscustomobject]@{
    path = $debugLogPath
    bytes = $debugFile.Length
    lastWriteTime = $debugFile.LastWriteTime.ToString('o')
    latestUsageInTail = $lastUsage
    latestAgentDurationMsInTail = $lastDurationMs
    latestStatusTokenCountInTail = $lastTokenCount
    caveat = 'The append-only log can interleave live sessions and tests.'
  }
}

$processGroups = @()
$processes = @()
if (-not $SkipProcesses) {
  $processNames = @(
    'node',
    'book',
    'codex',
    'codex-code-mode-host',
    'codex-command-runner-0.145.0',
    'node_repl'
  )
  $processes = @(Get-Process | Where-Object { $_.ProcessName -in $processNames } | ForEach-Object {
    $processPath = $null
    $startedAt = $null
    try {
      $processPath = $_.Path
    } catch {
      $processPath = $null
    }
    try {
      $startedAt = $_.StartTime.ToString('o')
    } catch {
      $startedAt = $null
    }
    [pscustomobject]@{
      pid = $_.Id
      name = $_.ProcessName
      cpuSeconds = if ($null -eq $_.CPU) { $null } else { [math]::Round($_.CPU, 2) }
      workingSetBytes = $_.WorkingSet64
      startedAt = $startedAt
      path = $processPath
    }
  })
  $processGroups = @($processes | Group-Object name | ForEach-Object {
    [pscustomobject]@{
      name = $_.Name
      count = $_.Count
      cpuSeconds = [math]::Round((($_.Group | Measure-Object cpuSeconds -Sum).Sum ?? 0), 2)
      workingSetBytes = [long](($_.Group | Measure-Object workingSetBytes -Sum).Sum ?? 0)
    }
  } | Sort-Object name)
}

$summary = [pscustomobject]@{
  active = $activeAgents.Count
  queued = @($allAgents | Where-Object status -eq 'queued').Count
  starting = @($allAgents | Where-Object status -eq 'starting').Count
  running = @($allAgents | Where-Object status -eq 'running').Count
  waitingInput = @($allAgents | Where-Object status -eq 'waiting_input').Count
  waitingPermission = @($allAgents | Where-Object status -eq 'waiting_permission').Count
  persistedAgents = $allAgents.Count
  completed = $completedAgents.Count
  failed = $failedAgents.Count
  interrupted = $interruptedAgents.Count
  totalTokens = $totalTokens
  telemetryEvents = $telemetryEvents.Count
  duplicateTerminalEvents = $duplicateTerminalEvents
}

$snapshot = [ordered]@{
  schemaVersion = 1
  capturedAt = $capturedAt.ToString('o')
  privacy = 'Prompts, transcripts, results, evidence bodies, and raw errors are excluded.'
  workspace = [pscustomobject]@{
    root = $repoRoot
    repoHash = $repoHash
    branch = $branch
    head = $head
    dirtyPathCount = $statusLines.Count
    hasManagedAgentState = @($stores | Where-Object {
      (Get-Value $_ 'repoHash') -eq $repoHash -and (Get-Value $_ 'hasState' $false)
    }).Count -gt 0
  }
  summary = $summary
  statusCounts = Get-CountMap $allAgents { param($item) $item.status }
  roleCounts = Get-CountMap $allAgents { param($item) $item.role }
  modelCounts = Get-CountMap $allAgents { param($item) $item.model }
  errorCounts = $errorCounts
  telemetryEventCounts = $eventCounts
  stores = @($stores)
  agents = $allAgents
  activeAgents = $activeAgents
  debugLog = $debugLog
  processAttributionCaveat = 'Generic Node processes cannot be reliably attributed without command-line access.'
  processGroups = $processGroups
  processes = $processes
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$offset = $capturedAt.ToString('zzz').Replace(':', '')
$fileStamp = $capturedAt.ToString('yyyy-MM-ddTHHmmss') + $offset
$baseName = "agent-runtime-baseline-$fileStamp"
$jsonPath = Join-Path $OutputDirectory "$baseName.json"
$markdownPath = Join-Path $OutputDirectory "$baseName.md"

$snapshot | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $jsonPath -Encoding utf8

$lines = [Collections.Generic.List[string]]::new()
$lines.Add('# Book Agent Runtime Baseline')
$lines.Add('')
$lines.Add("- Captured: $($capturedAt.ToString('yyyy-MM-dd HH:mm:ss zzz'))")
$lines.Add("- Workspace: ``$repoRoot``")
$lines.Add("- Repository hash: ``$repoHash``")
$lines.Add("- Branch / HEAD: ``$branch`` / ``$head``")
$lines.Add("- Dirty or untracked paths: $($statusLines.Count)")
$lines.Add('- Privacy: prompts, transcripts, results, evidence bodies, and raw errors are excluded')
$lines.Add('')
$lines.Add('## Current State')
$lines.Add('')
Add-MarkdownTable $lines @('Metric', 'Value') @(
  New-MarkdownRow @('Active managed agents', $summary.active)
  New-MarkdownRow @('Queued', $summary.queued)
  New-MarkdownRow @('Starting', $summary.starting)
  New-MarkdownRow @('Running', $summary.running)
  New-MarkdownRow @('Waiting for input', $summary.waitingInput)
  New-MarkdownRow @('Waiting for permission', $summary.waitingPermission)
  New-MarkdownRow @('Persisted agents', $summary.persistedAgents)
  New-MarkdownRow @('Completed', $summary.completed)
  New-MarkdownRow @('Failed', $summary.failed)
  New-MarkdownRow @('Interrupted', $summary.interrupted)
  New-MarkdownRow @('Recorded total tokens', $summary.totalTokens)
  New-MarkdownRow @('Raw telemetry events', $summary.telemetryEvents)
  New-MarkdownRow @('Duplicate terminal telemetry events', $summary.duplicateTerminalEvents)
)
$lines.Add('')
if (-not $snapshot.workspace.hasManagedAgentState) {
  $lines.Add("No managed-agent state store exists for this workspace hash (``$repoHash``).")
  $lines.Add('The aggregate tables are host-wide Book data from populated stores.')
  $lines.Add('')
}

$lines.Add('## Store Summary')
$lines.Add('')
$storeRows = @($stores | Where-Object { Get-Value $_ 'hasState' $false } | ForEach-Object {
  $counts = Get-Value $_ 'statusCounts' @{}
  $statusText = ($counts.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '
  New-MarkdownRow @(
    "``$($_.repoHash)``",
    $_.agentCount,
    $_.activeCount,
    $statusText,
    $_.totalTokens,
    $_.meanDurationMs,
    $_.maxDurationMs,
    $_.stateBytes,
    $_.metricsEvents
  )
})
Add-MarkdownTable $lines @(
  'Repository hash',
  'Agents',
  'Active',
  'Status',
  'Tokens',
  'Mean duration ms',
  'Max duration ms',
  'State bytes',
  'Events'
) $storeRows
$lines.Add('')

$lines.Add('## Active Agents')
$lines.Add('')
if ($activeAgents.Count -eq 0) {
  $lines.Add('No active managed agents were found.')
} else {
  $activeRows = @($activeAgents | ForEach-Object {
    New-MarkdownRow @(
      "``$($_.repoHash)``",
      "``$($_.agentId)``",
      $_.profile,
      $_.status,
      "``$($_.model)``",
      $_.activityKind,
      $_.totalTokens,
      $_.durationMs
    )
  })
  Add-MarkdownTable $lines @(
    'Repository',
    'Agent ID',
    'Profile',
    'Status',
    'Model',
    'Activity',
    'Tokens',
    'Duration ms'
  ) $activeRows
}
$lines.Add('')

$lines.Add('## Failure Classes')
$lines.Add('')
$errorRows = @($errorCounts.GetEnumerator() | Sort-Object Name | ForEach-Object {
  New-MarkdownRow @($_.Key, $_.Value)
})
if ($errorRows.Count -eq 0) {
  $lines.Add('No persisted failure classes were found.')
} else {
  Add-MarkdownTable $lines @('Class', 'Count') $errorRows
}
$lines.Add('')

$lines.Add('## Telemetry Events')
$lines.Add('')
$eventRows = @($eventCounts.GetEnumerator() | Sort-Object Name | ForEach-Object {
  New-MarkdownRow @($_.Key, $_.Value)
})
if ($eventRows.Count -eq 0) {
  $lines.Add('No telemetry events were found.')
} else {
  Add-MarkdownTable $lines @('Event', 'Count') $eventRows
}
$lines.Add('')
$lines.Add('State records are authoritative for run counts. Raw telemetry can contain repeated terminal events.')
$lines.Add('')

if ($null -ne $debugLog) {
  $lines.Add('## Debug Log')
  $lines.Add('')
  Add-MarkdownTable $lines @('Metric', 'Value') @(
    New-MarkdownRow @('Bytes', $debugLog.bytes)
    New-MarkdownRow @('Last write time', $debugLog.lastWriteTime)
    New-MarkdownRow @('Latest prompt tokens in tail', (Get-Value $debugLog.latestUsageInTail 'promptTokens'))
    New-MarkdownRow @('Latest completion tokens in tail', (Get-Value $debugLog.latestUsageInTail 'completionTokens'))
    New-MarkdownRow @('Latest total tokens in tail', (Get-Value $debugLog.latestUsageInTail 'totalTokens'))
    New-MarkdownRow @('Latest agent duration ms in tail', $debugLog.latestAgentDurationMsInTail)
    New-MarkdownRow @('Latest status token count in tail', $debugLog.latestStatusTokenCountInTail)
  )
  $lines.Add('')
  $lines.Add($debugLog.caveat)
  $lines.Add('')
}

if (-not $SkipProcesses) {
  $lines.Add('## Host Process Snapshot')
  $lines.Add('')
  $lines.Add('Generic Node processes cannot be reliably attributed to Book without command-line access.')
  $lines.Add('')
  $processRows = @($processGroups | ForEach-Object {
    New-MarkdownRow @($_.name, $_.count, $_.cpuSeconds, $_.workingSetBytes)
  })
  Add-MarkdownTable $lines @('Process', 'Count', 'CPU seconds', 'Working set bytes') $processRows
  $lines.Add('')
}

$lines.Add('## Machine-Readable Data')
$lines.Add('')
$lines.Add("Full privacy-filtered details are in ``$([IO.Path]::GetFileName($jsonPath))``.")

$lines | Set-Content -LiteralPath $markdownPath -Encoding utf8

Write-Output "Markdown: $markdownPath"
Write-Output "JSON:     $jsonPath"
Write-Output "Active managed agents: $($summary.active)"
Write-Output "Persisted agents: $($summary.persistedAgents)"
Write-Output "Completed / failed / interrupted: $($summary.completed) / $($summary.failed) / $($summary.interrupted)"
