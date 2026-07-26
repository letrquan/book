/* Hallmark · component: command instrument panel · genre: modern-minimal · theme: existing TUI
 * states: default · narrow · empty · warning · reduced-motion · screen-reader
 * contrast: pass (40–41; inherited from ThemeTokens)
 * Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V5
 */
import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type {
  ConfigCommandDisplay,
  ContextCommandDisplay,
  LocalCommandDisplay,
  UsageCommandDisplay,
} from '../../types/messages.js';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { failureTotal, formatFailureCounts } from '../../pricing.js';
import { padDisplay, truncateDisplay, wordWrap } from './word-wrap.js';

interface CommandPanelProps {
  display: LocalCommandDisplay;
  fallback: string;
  terminalWidth?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

interface ConfigEntry {
  path: string;
  value: string;
}

interface Metric {
  label: string;
  value: string;
  color?: string;
}

const REVEAL_STEPS = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}m`;
  }
  if (absolute >= 1_000) {
    return `${(value / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)}k`;
  }
  return value.toLocaleString();
}

function formatDuration(durationMs: number): string {
  if (durationMs <= 0) return '—';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function formatConfigValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function flattenConfigValue(
  value: unknown,
  path: string,
  entries: ConfigEntry[],
  depth: number,
): void {
  if (depth > 7) {
    entries.push({ path, value: formatConfigValue(value) });
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      entries.push({ path, value: '[]' });
      return;
    }
    if (value.every((item) => item === null || typeof item !== 'object')) {
      entries.push({ path, value: value.map(formatConfigValue).join(', ') });
      return;
    }
    value.forEach((item, index) => {
      flattenConfigValue(item, `${path}[${index}]`, entries, depth + 1);
    });
    return;
  }

  if (value && typeof value === 'object') {
    const objectEntries = Object.entries(value as Record<string, unknown>);
    if (objectEntries.length === 0) {
      entries.push({ path, value: '{}' });
      return;
    }
    for (const [key, nested] of objectEntries) {
      flattenConfigValue(nested, path ? `${path}.${key}` : key, entries, depth + 1);
    }
    return;
  }

  entries.push({ path, value: formatConfigValue(value) });
}

export function flattenConfigSnapshot(snapshot: Record<string, unknown>): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    flattenConfigValue(value, key, entries, 0);
  }
  return entries;
}

function revealProgress(step: number, startAt = 1): number {
  return clamp((step - startAt) / Math.max(1, REVEAL_STEPS - startAt), 0, 1);
}

function ScanRail({ width, progress }: { width: number; progress: number }) {
  const theme = useTheme();
  const safeWidth = Math.max(8, width);
  const head = Math.min(safeWidth - 1, Math.floor(progress * (safeWidth - 1)));

  return (
    <Box flexWrap="nowrap">
      <Text color={theme.brand}>{'─'.repeat(head)}</Text>
      <Text color={progress >= 1 ? theme.success : theme.brandShimmer}>•</Text>
      <Text color={theme.subtle} dimColor>
        {'─'.repeat(Math.max(0, safeWidth - head - 1))}
      </Text>
    </Box>
  );
}

function PanelHeader({
  command,
  title,
  subtitle,
  contentWidth,
  step,
}: {
  command: string;
  title: string;
  subtitle: string;
  contentWidth: number;
  step: number;
}) {
  const theme = useTheme();
  const ready = step >= REVEAL_STEPS;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" flexWrap="nowrap">
        <Text bold color={theme.brand}>
          {command} <Text color={theme.toolRail}>·</Text> <Text color={theme.text}>{title}</Text>
        </Text>
        <Text color={ready ? theme.success : theme.brandShimmer}>
          {ready ? 'ready' : 'reading'}
        </Text>
      </Box>
      <Text color={theme.subtle} dimColor>
        {truncateDisplay(subtitle, contentWidth)}
      </Text>
      <ScanRail width={contentWidth} progress={revealProgress(step, 0)} />
    </Box>
  );
}

function MetricGrid({
  metrics,
  contentWidth,
  narrow,
  illuminated,
}: {
  metrics: Metric[];
  contentWidth: number;
  narrow: boolean;
  illuminated: boolean;
}) {
  const theme = useTheme();

  if (narrow) {
    const labelWidth = Math.min(12, Math.max(8, Math.floor(contentWidth * 0.34)));
    const valueWidth = Math.max(8, contentWidth - labelWidth - 1);
    return (
      <Box flexDirection="column">
        {metrics.map((metric) => (
          <Box key={metric.label} flexWrap="nowrap">
            <Text color={theme.subtle} dimColor>
              {padDisplay(metric.label, labelWidth)}
            </Text>
            <Text color={illuminated ? (metric.color ?? theme.text) : theme.subtle} bold>
              {truncateDisplay(metric.value, valueWidth)}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  const columnWidth = Math.max(10, Math.floor(contentWidth / metrics.length));
  return (
    <Box flexDirection="row" flexWrap="nowrap">
      {metrics.map((metric) => (
        <Box key={metric.label} width={columnWidth} flexDirection="column">
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(metric.label, columnWidth - 1)}
          </Text>
          <Text color={illuminated ? (metric.color ?? theme.text) : theme.subtle} bold>
            {truncateDisplay(metric.value, columnWidth - 1)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function Meter({
  fraction,
  width,
  progress,
  color,
}: {
  fraction: number;
  width: number;
  progress: number;
  color: string;
}) {
  const theme = useTheme();
  const safeWidth = Math.max(5, width);
  const target = Math.round(clamp(fraction, 0, 1) * safeWidth);
  const filled = Math.round(target * clamp(progress, 0, 1));

  return (
    <Box flexWrap="nowrap">
      <Text color={color}>{'•'.repeat(filled)}</Text>
      <Text color={theme.subtle} dimColor>
        {'·'.repeat(Math.max(0, safeWidth - filled))}
      </Text>
    </Box>
  );
}

function StackedUsageMeter({
  promptTokens,
  completionTokens,
  totalTokens,
  width,
  progress,
}: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  width: number;
  progress: number;
}) {
  const theme = useTheme();
  const safeWidth = Math.max(8, width);
  const safeTotal = Math.max(1, totalTokens, promptTokens + completionTokens);
  const promptTarget = Math.round((promptTokens / safeTotal) * safeWidth);
  const completionTarget = Math.min(
    safeWidth - promptTarget,
    Math.round((completionTokens / safeTotal) * safeWidth),
  );
  const promptFilled = Math.round(promptTarget * progress);
  const completionFilled = Math.round(completionTarget * progress);
  const remainder = Math.max(0, safeWidth - promptFilled - completionFilled);

  return (
    <Box flexWrap="nowrap">
      <Text color={theme.brand}>{'•'.repeat(promptFilled)}</Text>
      <Text color={theme.success}>{'•'.repeat(completionFilled)}</Text>
      <Text color={theme.subtle} dimColor>
        {'·'.repeat(remainder)}
      </Text>
    </Box>
  );
}

function SectionLabel({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text color={theme.subtle} dimColor>
      {children}
    </Text>
  );
}

function ConfigPanelBody({
  data,
  contentWidth,
  narrow,
  step,
}: {
  data: ConfigCommandDisplay;
  contentWidth: number;
  narrow: boolean;
  step: number;
}) {
  const theme = useTheme();
  const entries = useMemo(() => flattenConfigSnapshot(data.snapshot), [data.snapshot]);
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const dotIndex = entry.path.indexOf('.');
      const bracketIndex = entry.path.indexOf('[');
      const boundaries = [dotIndex, bracketIndex].filter((index) => index >= 0);
      const boundary = boundaries.length > 0 ? Math.min(...boundaries) : entry.path.length;
      const group = entry.path.slice(0, boundary) || 'root';
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, narrow ? 3 : 5);
  }, [entries, narrow]);
  const maxGroup = Math.max(1, ...groups.map(([, count]) => count));
  const labelWidth = narrow ? Math.min(16, Math.floor(contentWidth * 0.42)) : 24;
  const valueWidth = Math.max(8, contentWidth - labelWidth - 1);
  const barWidth = Math.max(8, Math.min(narrow ? 16 : 28, contentWidth - 18));
  const progress = revealProgress(step, 2);
  const metrics: Metric[] = [
    { label: 'Model', value: data.runtime.model, color: theme.brand },
    { label: 'Provider', value: data.runtime.provider },
    { label: 'Mode', value: data.runtime.mode },
    { label: 'Budget', value: compactNumber(data.runtime.maxTokens) },
  ];

  return (
    <Box flexDirection="column">
      <MetricGrid
        metrics={metrics}
        contentWidth={contentWidth}
        narrow={narrow}
        illuminated={step >= 3}
      />
      <Box flexDirection="column">
        <SectionLabel>configuration signal map</SectionLabel>
        {groups.map(([group, count], index) => (
          <Box key={group} flexWrap="nowrap">
            <Text color={step >= 4 + index ? theme.text : theme.subtle}>
              {padDisplay(group, Math.min(14, Math.max(8, contentWidth - barWidth - 5)))}
            </Text>
            <Text> </Text>
            <Meter
              fraction={count / maxGroup}
              width={barWidth}
              progress={progress}
              color={index === 0 ? theme.brand : theme.brandShimmer}
            />
            <Text color={theme.subtle}> {count}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column">
        <SectionLabel>resolved values</SectionLabel>
        {entries.map((entry, index) => {
          const active = step >= Math.min(REVEAL_STEPS, 5 + (index % 4));
          const wrappedValue = wordWrap(entry.value, valueWidth);
          return narrow ? (
            <Box key={`${entry.path}-${index}`} flexDirection="column">
              <Text color={theme.subtle} dimColor>
                {truncateDisplay(entry.path, contentWidth)}
              </Text>
              <Text color={active ? theme.text : theme.subtle}>{wrappedValue}</Text>
            </Box>
          ) : (
            <Box key={`${entry.path}-${index}`} flexDirection="row">
              <Text color={theme.subtle} dimColor>
                {padDisplay(entry.path, labelWidth)}
              </Text>
              <Text> </Text>
              <Box width={valueWidth}>
                <Text color={active ? theme.text : theme.subtle}>{wrappedValue}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text color={theme.subtle} dimColor>
        {entries.length} resolved fields · sensitive provider values redacted
      </Text>
    </Box>
  );
}

function ContextPanelBody({
  data,
  contentWidth,
  narrow,
  step,
}: {
  data: ContextCommandDisplay;
  contentWidth: number;
  narrow: boolean;
  step: number;
}) {
  const theme = useTheme();
  const usageFraction = data.maxTokens > 0 ? data.estimatedTokens / data.maxTokens : 0;
  const percent = Math.round(clamp(usageFraction, 0, 1) * 100);
  const meterColor = percent >= 95 ? theme.error : percent >= 80 ? theme.warning : theme.brand;
  const roleTotal = Math.max(1, data.userTokens + data.assistantTokens);
  const meterWidth = Math.max(8, contentWidth - (narrow ? 18 : 24));
  const metrics: Metric[] = [
    { label: 'Window', value: compactNumber(data.maxTokens), color: theme.brand },
    { label: 'Estimate', value: compactNumber(data.estimatedTokens) },
    { label: 'Messages', value: String(data.totalMessages) },
    { label: 'Tools', value: `${data.toolCalls}/${data.toolResults}` },
  ];
  const ambient = [
    `commands ${data.ambient.commandCount}`,
    data.ambient.skillCount === undefined ? null : `skills ${data.ambient.skillCount}`,
    data.ambient.subagentCount === undefined ? null : `agents ${data.ambient.subagentCount}`,
    `memory ${data.ambient.hasMemoryIndex ? 'loaded' : 'none'}`,
    `rules ${data.ambient.hasClaudeMdLoader ? 'loaded' : 'none'}`,
  ].filter((item): item is string => Boolean(item));

  return (
    <Box flexDirection="column">
      <MetricGrid
        metrics={metrics}
        contentWidth={contentWidth}
        narrow={narrow}
        illuminated={step >= 3}
      />
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <SectionLabel>conversation pressure</SectionLabel>
          <Text bold color={meterColor}>
            {percent}%
          </Text>
        </Box>
        <Meter
          fraction={usageFraction}
          width={contentWidth}
          progress={revealProgress(step, 2)}
          color={meterColor}
        />
        <Text color={theme.subtle} dimColor>
          {compactNumber(data.estimatedTokens)} estimated / {compactNumber(data.maxTokens)} tokens
        </Text>
      </Box>
      <Box flexDirection="column">
        <SectionLabel>role split</SectionLabel>
        <Box flexWrap="nowrap">
          <Text>{padDisplay('user', narrow ? 10 : 12)}</Text>
          <Meter
            fraction={data.userTokens / roleTotal}
            width={meterWidth}
            progress={revealProgress(step, 4)}
            color={theme.brandShimmer}
          />
          <Text color={theme.subtle}> {compactNumber(data.userTokens)}</Text>
        </Box>
        <Box flexWrap="nowrap">
          <Text>{padDisplay('assistant', narrow ? 10 : 12)}</Text>
          <Meter
            fraction={data.assistantTokens / roleTotal}
            width={meterWidth}
            progress={revealProgress(step, 5)}
            color={theme.success}
          />
          <Text color={theme.subtle}> {compactNumber(data.assistantTokens)}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <SectionLabel>ambient context injected each turn</SectionLabel>
        <Text color={step >= 8 ? theme.text : theme.subtle}>{ambient.join('  ·  ')}</Text>
      </Box>
      <Text color={theme.subtle} dimColor>
        Estimate uses chars/4; provider usage remains authoritative.
      </Text>
    </Box>
  );
}

function UsagePanelBody({
  data,
  contentWidth,
  narrow,
  step,
}: {
  data: UsageCommandDisplay;
  contentWidth: number;
  narrow: boolean;
  step: number;
}) {
  const theme = useTheme();
  const usage = data.usage;
  const metrics: Metric[] = [
    { label: 'Turn', value: String(data.currentTurn), color: theme.brand },
    { label: 'Messages', value: String(data.messageCount) },
    { label: 'Latency', value: formatDuration(data.turnDurationMs) },
    {
      label: 'Est. cost',
      value: data.estimatedCostUsd === undefined ? '—' : `$${data.estimatedCostUsd.toFixed(4)}`,
      color: data.estimatedCostUsd === undefined ? theme.subtle : theme.success,
    },
  ];

  return (
    <Box flexDirection="column">
      <MetricGrid
        metrics={metrics}
        contentWidth={contentWidth}
        narrow={narrow}
        illuminated={step >= 3}
      />
      {usage ? (
        <>
          <Box flexDirection="column">
            <Box justifyContent="space-between">
              <SectionLabel>token traffic</SectionLabel>
              <Text bold color={theme.brand}>
                {usage.totalTokens.toLocaleString()}
              </Text>
            </Box>
            <StackedUsageMeter
              promptTokens={usage.promptTokens}
              completionTokens={usage.completionTokens}
              totalTokens={usage.totalTokens}
              width={contentWidth}
              progress={revealProgress(step, 2)}
            />
            <Box flexDirection={narrow ? 'column' : 'row'} justifyContent="space-between">
              <Text color={theme.brand}>• input {usage.promptTokens.toLocaleString()}</Text>
              <Text color={theme.success}>• output {usage.completionTokens.toLocaleString()}</Text>
              {usage.cacheReadInputTokens ? (
                <Text color={theme.subtle}>
                  cache {usage.cacheReadInputTokens.toLocaleString()}
                </Text>
              ) : null}
            </Box>
          </Box>
          <Box flexDirection="column">
            <SectionLabel>active model</SectionLabel>
            <Text color={step >= 8 ? theme.text : theme.subtle}>{data.model}</Text>
            <Text color={theme.subtle} dimColor>
              {data.rate
                ? `$${data.rate.inputPerMillion}/M input · $${data.rate.outputPerMillion}/M output`
                : 'Pricing is not configured for this model.'}
            </Text>
          </Box>
        </>
      ) : (
        <Box flexDirection="column">
          <SectionLabel>token traffic</SectionLabel>
          <Meter fraction={0} width={contentWidth} progress={1} color={theme.brand} />
          <Text color={theme.subtle}>No model response recorded in this session yet.</Text>
        </Box>
      )}
      {data.toolCallStats && data.toolCallStats.length > 0 ? (
        <Box flexDirection="column">
          <SectionLabel>tool calls</SectionLabel>
          <Text color={theme.subtle}>
            {`${data.toolCallStats.reduce((sum, entry) => sum + entry.calls, 0)} total`}
            {(() => {
              const failed = data.toolCallStats.reduce(
                (sum, entry) => sum + failureTotal(entry.failures),
                0,
              );
              return failed > 0 ? ` · ${failed} failed` : '';
            })()}
            {data.toolCallStats.length > 8
              ? ` · showing 8 of ${data.toolCallStats.length} tools`
              : ''}
          </Text>
          {data.toolCallStats.slice(0, 8).map((entry) => {
            const failed = failureTotal(entry.failures);
            return (
              <Box key={entry.tool} flexWrap="nowrap">
                <Text color={step >= 8 ? theme.text : theme.subtle}>
                  {padDisplay(entry.tool, narrow ? 12 : 16)}
                  {String(entry.calls)}
                </Text>
                {failed > 0 ? (
                  <Text color={theme.error}> · {formatFailureCounts(entry.failures)}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : null}
      <Text color={theme.subtle} dimColor>
        Cost is a local estimate for the active model, not a billing statement.
      </Text>
    </Box>
  );
}

export function CommandPanel({
  display,
  fallback,
  terminalWidth = 80,
  reducedMotion = false,
  screenReader = false,
}: CommandPanelProps) {
  const theme = useTheme();
  const motionDisabled = reducedMotion || screenReader;
  const step = useStaggeredReveal(REVEAL_STEPS, true, 55, motionDisabled);

  if (screenReader) {
    return (
      <Box marginLeft={0} flexDirection="column">
        <Text>{fallback}</Text>
      </Box>
    );
  }

  const panelWidth = clamp(Math.floor(terminalWidth) - 2, 28, 96);
  const contentWidth = Math.max(18, panelWidth - 4);
  const narrow = panelWidth < 58;
  const header =
    display.kind === 'config'
      ? {
          command: '/config',
          title: 'Runtime map',
          subtitle: `${display.runtime.provider} · ${display.runtime.workspace}`,
        }
      : display.kind === 'context'
        ? {
            command: '/context',
            title: 'Window map',
            subtitle: `${display.model} · estimated conversation load before ambient injection`,
          }
        : {
            command: '/usage',
            title: 'Session telemetry',
            subtitle: `${display.model} · cumulative provider-reported activity`,
          };

  return (
    <Box
      marginLeft={2}
      width={panelWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
    >
      <PanelHeader {...header} contentWidth={contentWidth} step={step} />
      {display.kind === 'config' ? (
        <ConfigPanelBody data={display} contentWidth={contentWidth} narrow={narrow} step={step} />
      ) : display.kind === 'context' ? (
        <ContextPanelBody data={display} contentWidth={contentWidth} narrow={narrow} step={step} />
      ) : (
        <UsagePanelBody data={display} contentWidth={contentWidth} narrow={narrow} step={step} />
      )}
    </Box>
  );
}
