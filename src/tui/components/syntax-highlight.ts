import type { ThemeTokens } from '../../types.js';

export interface StyledSegment {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dimColor?: boolean;
}

export type StyledLine = StyledSegment[];

const cache = new Map<string, StyledLine[]>();
const MAX_CACHE_ENTRIES = 80;

function normalizeLang(lang?: string): string {
  const normalized = (lang ?? '').toLowerCase().trim();
  if (normalized === 'js') return 'javascript';
  if (normalized === 'jsx') return 'javascript';
  if (normalized === 'ts') return 'typescript';
  if (normalized === 'tsx') return 'typescript';
  if (normalized === 'py') return 'python';
  if (normalized === 'sh' || normalized === 'shell') return 'bash';
  if (normalized === 'yml') return 'yaml';
  return normalized;
}

function pushSegment(line: StyledLine, text: string, segment: Omit<StyledSegment, 'text'> = {}) {
  if (!text) return;
  const previous = line[line.length - 1];
  if (
    previous &&
    previous.color === segment.color &&
    previous.bold === segment.bold &&
    previous.italic === segment.italic &&
    previous.dimColor === segment.dimColor
  ) {
    previous.text += text;
    return;
  }
  line.push({ text, ...segment });
}

function keywordPattern(lang: string): RegExp | null {
  if (['javascript', 'typescript'].includes(lang)) {
    return /\b(?:async|await|break|case|catch|class|const|continue|default|delete|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|new|null|of|return|switch|throw|true|try|type|typeof|undefined|var|void|while|yield)\b/y;
  }
  if (lang === 'python') {
    return /\b(?:and|as|assert|async|await|break|class|continue|def|elif|else|except|False|finally|for|from|if|import|in|is|lambda|None|not|or|pass|raise|return|True|try|while|with|yield)\b/y;
  }
  if (lang === 'rust') {
    return /\b(?:as|async|await|break|const|continue|crate|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\b/y;
  }
  if (lang === 'go') {
    return /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/y;
  }
  if (lang === 'bash') {
    return /\b(?:case|do|done|elif|else|esac|fi|for|function|if|in|select|then|until|while)\b/y;
  }
  if (lang === 'sql') {
    return /\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|INSERT|INTO|UPDATE|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|VALUES|SET|AND|OR|NOT|NULL|AS|LIMIT|OFFSET|HAVING)\b/iy;
  }
  if (lang === 'css') {
    return /\b(?:display|position|absolute|relative|fixed|grid|flex|block|inline|color|background|border|padding|margin|width|height|content|media|import|keyframes)\b/y;
  }
  return null;
}

function highlightLine(raw: string, lang: string, theme: ThemeTokens): StyledLine {
  const line: StyledLine = [];
  const keyword = keywordPattern(lang);
  let i = 0;

  while (i < raw.length) {
    const rest = raw.slice(i);

    const commentStart = lang === 'python' || lang === 'bash' || lang === 'yaml' ? '#' : '//';
    if (rest.startsWith(commentStart)) {
      pushSegment(line, rest, { color: theme.mdCodeComment, italic: true, dimColor: true });
      break;
    }
    if (rest.startsWith('/*')) {
      const end = raw.indexOf('*/', i + 2);
      const text = end === -1 ? rest : raw.slice(i, end + 2);
      pushSegment(line, text, { color: theme.mdCodeComment, italic: true, dimColor: true });
      i += text.length;
      continue;
    }

    const stringMatch = rest.match(/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/);
    if (stringMatch) {
      pushSegment(line, stringMatch[0], { color: theme.mdCodeString });
      i += stringMatch[0].length;
      continue;
    }

    const numberMatch = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (numberMatch) {
      pushSegment(line, numberMatch[0], { color: theme.mdCodeNumber });
      i += numberMatch[0].length;
      continue;
    }

    const functionMatch = rest.match(/^([A-Za-z_$][\w$-]*)(?=\s*\()/);
    if (functionMatch) {
      pushSegment(line, functionMatch[1], { color: theme.mdCodeFunction });
      i += functionMatch[1].length;
      continue;
    }

    if (keyword) {
      keyword.lastIndex = i;
      const match = keyword.exec(raw);
      if (match && match.index === i) {
        pushSegment(line, match[0], { color: theme.mdCodeKeyword, bold: true });
        i += match[0].length;
        continue;
      }
    }

    pushSegment(line, raw[i], { color: theme.mdCodeText });
    i += 1;
  }

  return line.length > 0 ? line : [{ text: '', color: theme.mdCodeText }];
}

export function highlightCode(code: string, lang: string | undefined, theme: ThemeTokens): StyledLine[] {
  const normalized = normalizeLang(lang);
  const key = `${normalized}\0${code}\0${JSON.stringify({
    keyword: theme.mdCodeKeyword,
    string: theme.mdCodeString,
    comment: theme.mdCodeComment,
    number: theme.mdCodeNumber,
    function: theme.mdCodeFunction,
    text: theme.mdCodeText,
  })}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const lines = code.split('\n').map((line) => highlightLine(line, normalized, theme));
  cache.set(key, lines);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return lines;
}
