// src/index.ts
import {
  eventSource,
  event_types,
  extension_prompt_roles,
  extension_prompt_types,
  getRequestHeaders,
  isGenerating,
  saveSettingsDebounced,
  setExtensionPrompt,
  stopGeneration
} from "../../../../../script.js";
import { extension_settings, getContext } from "../../../../extensions.js";
import { translate } from "../../../../i18n.js";
import {
  canViewSecrets,
  deleteSecret,
  findSecret,
  secret_state,
  writeSecret
} from "../../../../secrets.js";

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/segmenter.js
var DEFAULT_TABLE_PLACEHOLDER = "\u6B64\u5904\u7701\u7565\u4E00\u4E2A\u8868\u683C\u3002";
var SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/;
var INLINE_SENTENCE_END_RE = /[。！？!?；;…]/;
var TABLE_DELIM_CELL_RE = /^:?-+:?$/;
var TABLE_DELIM_CHARS_RE = /^[\s|:-]*$/;
var UNESCAPED_PIPE_RE = /(?:^|[^\\])\|/;
var FENCE_LANG_PREFIX_RE = /^[ \t]*[A-Za-z0-9_+.#-]{1,32}[ \t]*\r?\n/;
var MAX_FRONTMATTER_KEY_CHARS = 120;
var YAML_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
var YAML_HEADER = /^[ \t]*(?:-[ \t]+)?(?:[\p{L}\p{N}_.-]+|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:/u;
var YAML_KEY_PREFIX = /^[ \t]*(?:-[ \t]+)?(?:[\p{L}\p{N}_.-]+[ \t]*|"(?:[^"\\]|\\.)*(?:\\|"[ \t]*)?|'(?:[^']|'')*(?:'[ \t]*)?)$/u;
function classifyFirstLine(line, complete) {
  if (/^[ \t]*#/.test(line))
    return "metadata";
  if (/^[ \t]*$/.test(line))
    return "pending";
  const header = YAML_HEADER.exec(line.slice(0, MAX_FRONTMATTER_KEY_CHARS + 1));
  if (header) {
    const next = line[header[0].length];
    if (next === void 0)
      return complete ? "metadata" : "pending";
    return next === " " || next === "	" ? "metadata" : "body";
  }
  if (!complete && YAML_CLOSE.test(line))
    return "pending";
  if (!complete && line.length <= MAX_FRONTMATTER_KEY_CHARS) {
    if (isHighSurrogate(line.charCodeAt(line.length - 1)) || YAML_KEY_PREFIX.test(line))
      return "pending";
  }
  return "body";
}
var LeadingFrontmatter = class {
  phase = "opening";
  partial = "";
  held = "";
  release(body) {
    this.phase = "body";
    this.partial = "";
    this.held = "";
    return body;
  }
  read(chunk, final = false) {
    if (this.phase === "body")
      return chunk;
    let start = 0;
    for (; ; ) {
      const nl = chunk.indexOf("\n", start);
      const complete = nl !== -1 || final;
      this.partial += nl === -1 ? chunk.slice(start) : chunk.slice(start, nl);
      if (!complete && this.phase === "metadata")
        return "";
      const line = this.partial.endsWith("\r") ? this.partial.slice(0, -1) : this.partial;
      const rest = nl === -1 ? "" : chunk.slice(nl + 1);
      if (this.phase === "opening") {
        if (!complete && /^\uFEFF?(?:-{0,2}|---[ \t]*)$/.test(line))
          return "";
        if (nl === -1 || !/^\uFEFF?---[ \t]*$/.test(line)) {
          return this.release(this.partial + (nl === -1 ? "" : "\n" + rest));
        }
        this.phase = "first";
      } else {
        if (complete && YAML_CLOSE.test(line))
          return this.release(rest);
        if (this.phase === "first") {
          const kind = classifyFirstLine(line, complete);
          if (kind === "body") {
            return this.release(this.held + this.partial + (nl === -1 ? "" : "\n" + rest));
          }
          if (kind === "metadata")
            this.phase = "metadata";
        }
        if (nl === -1)
          return final ? this.release(this.held + this.partial) : "";
        this.held += this.partial + "\n";
      }
      this.partial = "";
      start = nl + 1;
      if (start === chunk.length && !final)
        return "";
    }
  }
};
function hasNonDecimalPeriodEnd(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 46)
      continue;
    const prev = i > 0 ? text.charCodeAt(i - 1) : -1;
    if (prev >= 48 && prev <= 57)
      continue;
    if (i + 1 === text.length || /\s/.test(text[i + 1]))
      return true;
  }
  return false;
}
function hasOpenInlineConstruct(text, maxOpenWindow) {
  const limit = Math.max(16, Math.min(maxOpenWindow, 160));
  const openWiki = text.lastIndexOf("[[");
  if (openWiki !== -1 && text.indexOf("]]", openWiki + 2) === -1 && text.length - openWiki < limit && !/[。！？\n]/.test(text.slice(openWiki + 2))) {
    return true;
  }
  const openLinkParen = text.lastIndexOf("](");
  if (openLinkParen !== -1 && text.indexOf(")", openLinkParen + 2) === -1 && text.length - openLinkParen < limit && !/[\s\n]/.test(text.slice(openLinkParen + 2))) {
    return true;
  }
  const openBracket = text.lastIndexOf("[");
  if (openBracket !== -1 && text.indexOf("]", openBracket + 1) === -1 && text.length - openBracket < limit && !/[。！？\n]/.test(text.slice(openBracket + 1)) && !hasNonDecimalPeriodEnd(text.slice(openBracket + 1))) {
    return true;
  }
  const openAngleUrl = text.lastIndexOf("<http");
  if (openAngleUrl !== -1 && text.indexOf(">", openAngleUrl + 5) === -1 && text.length - openAngleUrl < limit && !/[\s\n]/.test(text.slice(openAngleUrl + 5))) {
    return true;
  }
  const bareUrlMatch = /https?:\/\/[^\s<>()[\]"'”’），。！？、；：]*$/.exec(text);
  if (bareUrlMatch && bareUrlMatch[0].length < limit)
    return true;
  return false;
}
function isTableDelimiterLine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("|"))
    return false;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = stripped.split("|").map((c) => c.trim());
  if (cells.length === 0)
    return false;
  return cells.every((cell) => TABLE_DELIM_CELL_RE.test(cell));
}
function isTableRowLine(line) {
  const trimmed = line.trim();
  if (!trimmed)
    return false;
  const withoutWikilinks = trimmed.replace(/\[\[[^\]]*\]\]/g, "");
  return UNESCAPED_PIPE_RE.test(withoutWikilinks);
}
function stripMarkdownTables(text, options = {}) {
  const policy = options.policy ?? "skip";
  const placeholder = options.placeholder ?? DEFAULT_TABLE_PLACEHOLDER;
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let fenceChar = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (fenceChar === null)
        fenceChar = ch;
      else if (fenceChar === ch)
        fenceChar = null;
      out.push(line);
      continue;
    }
    if (fenceChar !== null) {
      out.push(line);
      continue;
    }
    if (isTableRowLine(line) && i + 1 < lines.length && isTableDelimiterLine(lines[i + 1])) {
      i += 1;
      while (i + 1 < lines.length && isTableRowLine(lines[i + 1])) {
        i += 1;
      }
      if (policy === "placeholder" && placeholder.trim()) {
        out.push(placeholder);
      } else {
        out.push("");
      }
      continue;
    }
    if (isTableDelimiterLine(line)) {
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
function cleanMarkdownBody(text, options) {
  const withoutFences = text.replace(/`{3,}[\s\S]*?`{3,}/g, " ").replace(/~{3,}[\s\S]*?~{3,}/g, " ");
  const withoutMath = withoutFences.replace(/\$\$[\s\S]*?\$\$/g, " ");
  const withoutTables = stripMarkdownTables(withoutMath, options);
  return withoutTables.replace(/`([^`]*)`/g, "$1").replace(/!\[\[[^\]]*\]\]/g, " ").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<https?:\/\/[^\s<>]+>/gi, " ").replace(/https?:\/\/[^\s<>()[\]"'”’），。！？、；：]+/gi, " ").replace(/^[ \t]*>[ \t]*\[![A-Za-z0-9_-]+\][+-]?(?:[ \t]+(.*))?$/gm, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^(?:[ \t]*>[ \t]?)+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/^[-*+]\s+/gm, "").replace(/^\d+\.\s+/gm, "").replace(/^[-*_]{3,}\s*$/gm, " ").replace(/<\/?(?:b|i|u|br|p|span|div|strong|em|s|sub|sup|h[1-6]|ul|ol|li|a|img|code|pre|blockquote|hr|table|tr|td|th)\b[^>]*>/gi, " ");
}
function sanitizeForTts(text) {
  return String(text).replace(/[*_#|^=+~`]/g, " ").replace(/\s{2,}/g, " ").replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1").trim();
}
function splitSentences(chunk) {
  const sentences = [];
  let start = 0;
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length;
    if (m[0] === "." && end === chunk.length && /\d/.test(chunk[m.index - 1] ?? ""))
      continue;
    sentences.push(chunk.slice(start, end));
    start = end;
    lastEnd = end;
  }
  return { sentences, tail: chunk.slice(lastEnd) };
}
function isHighSurrogate(code) {
  return code >= 55296 && code <= 56319;
}
function isLowSurrogate(code) {
  return code >= 56320 && code <= 57343;
}
function cutHead(text, max) {
  if (!text || !Number.isFinite(max) || max <= 0)
    return ["", text];
  if (text.length <= max)
    return [text, ""];
  let idx = -1;
  for (let i = Math.min(Math.floor(max), text.length) - 1; i > 0; i--) {
    if (/[，,、\s]/.test(text[i])) {
      idx = i + 1;
      break;
    }
  }
  if (idx <= 0)
    idx = Math.max(1, Math.floor(max / 2));
  if (idx > 0 && idx < text.length && isHighSurrogate(text.charCodeAt(idx - 1)) && isLowSurrogate(text.charCodeAt(idx))) {
    idx = idx > 1 ? idx - 1 : Math.min(2, text.length);
  }
  return [text.slice(0, idx), text.slice(idx)];
}
var SentenceSegmenter = class {
  rawBuffer = "";
  maxChars;
  tablePolicy;
  tablePlaceholder;
  // YAML frontmatter state (document start only)
  frontmatter = new LeadingFrontmatter();
  // Cross-delta code fence state (` ``` ` and `~~~`)
  fenceChar = null;
  hangChars = "";
  fenced = "";
  // Cross-delta block math state (`$$...$$`)
  inMath = false;
  hangDollar = "";
  mathBuf = "";
  // Cross-delta Markdown pipe table state
  inTable = false;
  tableHintEmitted = false;
  pendingHeader = null;
  lineBuf = "";
  lineCommitted = false;
  constructor(options = {}) {
    const requested = options.maxSentenceChars ?? 200;
    this.maxChars = Number.isFinite(requested) ? Math.max(2, Math.floor(requested)) : 200;
    this.tablePolicy = options.tablePolicy ?? "skip";
    this.tablePlaceholder = options.tablePlaceholder ?? DEFAULT_TABLE_PLACEHOLDER;
  }
  emitTableBoundary() {
    if (this.tablePolicy === "placeholder" && !this.tableHintEmitted && this.tablePlaceholder.trim()) {
      this.tableHintEmitted = true;
      return `${this.tablePlaceholder}
`;
    }
    return "\n";
  }
  /** Cross-delta fenced code block filter supporting both ` ``` ` and `~~~`. */
  dropFences(chunk) {
    let s = this.hangChars + chunk;
    this.hangChars = "";
    const trail = /(`+|~+)$/.exec(s);
    const hang = trail ? trail[0] : "";
    if (hang.length > 0 && hang.length <= 2) {
      this.hangChars = hang;
      s = s.slice(0, -hang.length);
    }
    let out = "";
    for (; ; ) {
      const m = this.fenceChar === null ? /(`{3,}|~{3,})/.exec(s) : this.fenceChar === "`" ? /`{3,}/.exec(s) : /~{3,}/.exec(s);
      if (!m) {
        if (this.fenceChar !== null)
          this.fenced += s;
        else
          out += s;
        return out;
      }
      if (this.fenceChar !== null) {
        this.fenced += s.slice(0, m.index);
        this.fenceChar = null;
        this.fenced = "";
      } else {
        out += s.slice(0, m.index) + "\n";
        this.fenceChar = m[0][0];
      }
      s = s.slice(m.index + m[0].length);
    }
  }
  /** Cross-delta block math (`$$...$$`) filter. */
  dropBlockMath(chunk) {
    let s = this.hangDollar + chunk;
    this.hangDollar = "";
    if (s.endsWith("$") && !s.endsWith("$$")) {
      this.hangDollar = "$";
      s = s.slice(0, -1);
    }
    let out = "";
    for (; ; ) {
      const idx = s.indexOf("$$");
      if (idx === -1) {
        if (this.inMath)
          this.mathBuf += s;
        else
          out += s;
        return out;
      }
      if (this.inMath) {
        this.mathBuf = "";
        this.inMath = false;
        out += " ";
      } else {
        out += s.slice(0, idx) + " ";
        this.inMath = true;
      }
      s = s.slice(idx + 2);
    }
  }
  /** Cross-delta Markdown pipe table filter with zero latency for regular prose lines. */
  filterTables(chunk) {
    const normalized = chunk.replace(/\r\n/g, "\n");
    let out = "";
    let pos = 0;
    while (pos < normalized.length) {
      const nl = normalized.indexOf("\n", pos);
      if (nl !== -1) {
        const segment = normalized.slice(pos, nl);
        pos = nl + 1;
        if (this.lineCommitted) {
          out += segment + "\n";
          this.lineCommitted = false;
          continue;
        }
        const line = this.lineBuf + segment;
        this.lineBuf = "";
        out += this.handleCompleteLine(line);
      } else {
        const rest = normalized.slice(pos);
        pos = normalized.length;
        if (this.lineCommitted) {
          out += rest;
          continue;
        }
        this.lineBuf += rest;
        if (this.inTable) {
          continue;
        }
        if (this.pendingHeader !== null) {
          if (!TABLE_DELIM_CHARS_RE.test(this.lineBuf)) {
            const releasedHeader = this.pendingHeader;
            this.pendingHeader = null;
            out += releasedHeader + "\n";
            this.tryFlushRegularLineBuf((chunkOut) => {
              out += chunkOut;
            });
          }
          continue;
        }
        this.tryFlushRegularLineBuf((chunkOut) => {
          out += chunkOut;
        });
      }
    }
    return out;
  }
  tryFlushRegularLineBuf(emit) {
    if (hasOpenInlineConstruct(this.lineBuf, this.maxChars))
      return;
    if (isTableRowLine(this.lineBuf))
      return;
    const shouldFlush = INLINE_SENTENCE_END_RE.test(this.lineBuf) || hasNonDecimalPeriodEnd(this.lineBuf) || this.lineBuf.length >= this.maxChars;
    if (shouldFlush) {
      emit(this.lineBuf);
      this.lineBuf = "";
      this.lineCommitted = true;
    }
  }
  handleCompleteLine(line) {
    if (this.inTable) {
      if (isTableRowLine(line) || isTableDelimiterLine(line)) {
        return "";
      }
      this.inTable = false;
      this.tableHintEmitted = false;
      if (!line.trim())
        return "\n";
      return line + "\n";
    }
    if (this.pendingHeader !== null) {
      const header = this.pendingHeader;
      this.pendingHeader = null;
      if (isTableDelimiterLine(line)) {
        this.inTable = true;
        this.tableHintEmitted = false;
        return this.emitTableBoundary();
      }
      const emitted = header + "\n";
      if (isTableRowLine(line)) {
        this.pendingHeader = line;
        return emitted;
      }
      return emitted + line + "\n";
    }
    if (isTableDelimiterLine(line)) {
      return "\n";
    }
    if (isTableRowLine(line)) {
      this.pendingHeader = line;
      return "";
    }
    return line + "\n";
  }
  flushTableState() {
    let out = "";
    if (this.inTable) {
      if (this.lineBuf && !isTableRowLine(this.lineBuf) && !isTableDelimiterLine(this.lineBuf)) {
        out += this.lineBuf;
      }
    } else if (this.pendingHeader !== null) {
      if (this.lineBuf && isTableDelimiterLine(this.lineBuf)) {
        out += this.emitTableBoundary();
      } else {
        out += this.pendingHeader + "\n";
        if (this.lineBuf && !isTableDelimiterLine(this.lineBuf)) {
          out += this.lineBuf;
        }
      }
    } else if (this.lineBuf && !isTableDelimiterLine(this.lineBuf)) {
      out += this.lineBuf;
    }
    this.inTable = false;
    this.tableHintEmitted = false;
    this.pendingHeader = null;
    this.lineBuf = "";
    this.lineCommitted = false;
    return out;
  }
  cleanCompleteText(raw) {
    return cleanMarkdownBody(raw, {
      policy: this.tablePolicy,
      placeholder: this.tablePlaceholder
    });
  }
  capSentence(s, out) {
    let rest = s;
    while (rest.length > this.maxChars) {
      const [head, tail] = cutHead(rest, this.maxChars);
      if (!head)
        break;
      rest = tail;
      const t2 = sanitizeForTts(head).trim();
      if (t2 && !SKIP_PREFIX.test(t2))
        out.push(t2);
    }
    const t = sanitizeForTts(rest).trim();
    if (t && !SKIP_PREFIX.test(t))
      out.push(t);
  }
  /** Split `rawBuffer` at complete sentence boundaries, running `plainText()` per complete sentence. */
  drainRawBuffer(out, isFinal) {
    if (!this.rawBuffer)
      return;
    if (!isFinal && hasOpenInlineConstruct(this.rawBuffer, this.maxChars)) {
      const lastNl = this.rawBuffer.lastIndexOf("\n");
      if (lastNl === -1)
        return;
      const readyPrefix = this.rawBuffer.slice(0, lastNl + 1);
      this.rawBuffer = this.rawBuffer.slice(lastNl + 1);
      const cleaned = this.cleanCompleteText(readyPrefix);
      const { sentences: sentences2, tail: tail2 } = splitSentences(cleaned);
      for (const s of sentences2)
        this.capSentence(s, out);
      if (tail2.trim())
        this.capSentence(tail2, out);
      return;
    }
    const { sentences, tail } = splitSentences(this.rawBuffer);
    this.rawBuffer = tail;
    for (const rawSentence of sentences) {
      const cleaned = this.cleanCompleteText(rawSentence);
      if (!cleaned)
        continue;
      const sub = splitSentences(cleaned);
      for (const s of sub.sentences)
        this.capSentence(s, out);
      if (sub.tail.trim())
        this.capSentence(sub.tail, out);
    }
    if (!isFinal) {
      while (this.rawBuffer.length > this.maxChars && !hasOpenInlineConstruct(this.rawBuffer, this.maxChars)) {
        const cleaned = this.cleanCompleteText(this.rawBuffer);
        if (cleaned.length <= this.maxChars) {
          this.rawBuffer = cleaned;
          break;
        }
        const [head, rest] = cutHead(cleaned, this.maxChars);
        if (!head)
          break;
        this.rawBuffer = rest;
        const t = sanitizeForTts(head).trim();
        if (t && !SKIP_PREFIX.test(t))
          out.push(t);
      }
      return;
    }
    if (this.rawBuffer) {
      const cleaned = this.cleanCompleteText(this.rawBuffer);
      this.rawBuffer = "";
      if (cleaned) {
        const sub = splitSentences(cleaned);
        for (const s of sub.sentences)
          this.capSentence(s, out);
        if (sub.tail.trim())
          this.capSentence(sub.tail, out);
      }
    }
  }
  /** Feed a raw streaming delta and return all completed sentences. */
  feed(chunk) {
    if (!chunk)
      return [];
    const noFrontmatter = this.frontmatter.read(chunk);
    const noFence = noFrontmatter ? this.dropFences(noFrontmatter) : "";
    const noMath = noFence ? this.dropBlockMath(noFence) : "";
    const noTable = noMath ? this.filterTables(noMath) : "";
    if (!noTable)
      return [];
    this.rawBuffer += noTable;
    const out = [];
    this.drainRawBuffer(out, false);
    return out;
  }
  /** Flush remaining buffered text at end-of-stream and reset internal state. */
  flush() {
    let tailRaw = this.frontmatter.read("", true);
    this.frontmatter = new LeadingFrontmatter();
    if (this.hangChars) {
      if (this.fenceChar !== null)
        this.fenced += this.hangChars;
      else
        tailRaw += this.hangChars;
      this.hangChars = "";
    }
    if (this.hangDollar) {
      if (this.inMath)
        this.mathBuf += this.hangDollar;
      else
        tailRaw += this.hangDollar;
      this.hangDollar = "";
    }
    if (this.inMath) {
      tailRaw += this.mathBuf;
      this.inMath = false;
      this.mathBuf = "";
    }
    if (tailRaw) {
      const filtered = this.filterTables(tailRaw);
      if (filtered)
        this.rawBuffer += filtered;
    }
    const trailingTable = this.flushTableState();
    if (trailingTable)
      this.rawBuffer += trailingTable;
    if (this.fenceChar !== null) {
      const restored = this.fenced.replace(FENCE_LANG_PREFIX_RE, "");
      this.rawBuffer += restored;
      this.fenceChar = null;
      this.fenced = "";
    }
    const out = [];
    this.drainRawBuffer(out, true);
    this.rawBuffer = "";
    return out;
  }
};

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/asr-replacements.js
var REPLACEMENTS_MAX_PAYLOAD_BYTES = 12e3;
var UTF8_ENCODER = new TextEncoder();
var ASCII_WORD = /[A-Za-z0-9]/;
var escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function replacementsPayloadBytes(rules) {
  return UTF8_ENCODER.encode(JSON.stringify(rules ?? [])).length;
}
function validateReplacements(rules) {
  if (!Array.isArray(rules)) {
    return { ok: false, error: "replacements must be an array" };
  }
  const normalized = [];
  for (let i = 0; i < rules.length; i++) {
    const item = rules[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `rule[${i}] must be an object` };
    }
    const rawFrom = item.from;
    const rawTo = item.to;
    if (!Array.isArray(rawFrom)) {
      return { ok: false, error: `rule[${i}].from must be an array of strings` };
    }
    if (typeof rawTo !== "string" || rawTo.trim().length === 0) {
      return { ok: false, error: `rule[${i}].to must be a non-empty string` };
    }
    const from = [];
    for (let j = 0; j < rawFrom.length; j++) {
      const entry = rawFrom[j];
      if (typeof entry !== "string") {
        return { ok: false, error: `rule[${i}].from[${j}] must be a string` };
      }
      if (entry.trim().length > 0)
        from.push(entry);
    }
    if (from.length === 0) {
      return { ok: false, error: `rule[${i}].from must contain at least one non-empty spelling` };
    }
    normalized.push({ from, to: rawTo });
  }
  const bytes = replacementsPayloadBytes(normalized);
  if (bytes > REPLACEMENTS_MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `replacements payload (${bytes} bytes) exceeds limit (${REPLACEMENTS_MAX_PAYLOAD_BYTES} bytes)`,
      bytes
    };
  }
  return { ok: true, rules: normalized, bytes };
}
function compilePattern(heard) {
  const trimmedStr = heard.replace(/\s+/g, " ").trim();
  const chars = [...trimmedStr];
  if (chars.length === 0)
    return null;
  let body = "";
  let prev = "";
  let spaced = false;
  for (const ch of chars) {
    if (ch === " ") {
      spaced = true;
      continue;
    }
    if (prev && (spaced || ASCII_WORD.test(prev) !== ASCII_WORD.test(ch)))
      body += "\\s*";
    body += escapeRegExp(ch);
    prev = ch;
    spaced = false;
  }
  const first = chars[0];
  const last = chars[chars.length - 1];
  const requireLeftBound = ASCII_WORD.test(first);
  const tail = ASCII_WORD.test(last) ? "(?![A-Za-z0-9])" : "";
  return { pattern: `${body}${tail}`, requireLeftBound };
}
function createAsrReplacer(rules, onHit) {
  const entries = [];
  rules.forEach((rule, ruleIndex) => {
    if (!rule.to)
      return;
    for (const heard of rule.from) {
      const compiled = compilePattern(heard);
      if (!compiled)
        continue;
      const compact = heard.replace(/\s+/g, "");
      entries.push({
        pattern: compiled.pattern,
        key: compact.toLowerCase(),
        to: rule.to,
        length: [...compact].length,
        ruleIndex,
        requireLeftBound: compiled.requireLeftBound
      });
    }
  });
  if (entries.length === 0)
    return (text) => text;
  entries.sort((a, b) => b.length - a.length);
  const targets = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (!targets.has(e.key)) {
      targets.set(e.key, {
        to: e.to,
        ruleIndex: e.ruleIndex,
        requireLeftBound: e.requireLeftBound
      });
    }
  }
  const source = entries.map((e) => `(?:${e.pattern})`).join("|");
  return (text, countHit = true) => {
    if (!text)
      return text;
    const regex = new RegExp(source, "giu");
    let out = "";
    let cursor = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const match = m[0];
      const offset = m.index;
      if (match.length === 0) {
        regex.lastIndex = offset + 1;
        continue;
      }
      const hit = targets.get(match.replace(/\s+/g, "").toLowerCase());
      if (!hit) {
        regex.lastIndex = offset + 1;
        continue;
      }
      if (hit.requireLeftBound && offset > 0 && ASCII_WORD.test(text[offset - 1])) {
        regex.lastIndex = offset + 1;
        continue;
      }
      out += text.slice(cursor, offset) + hit.to;
      if (onHit && countHit)
        onHit(hit.ruleIndex);
      cursor = offset + match.length;
      regex.lastIndex = cursor;
    }
    return cursor === 0 ? text : out + text.slice(cursor);
  };
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/emotion.js
var EMOTION_NAMES = [
  "neutral",
  "gentle",
  "happy",
  "sad",
  "angry",
  "excited",
  "tender",
  "serious",
  "playful",
  "nervous"
];
var EMOTION_TAG_PATTERN = "<\\s*(break\\s+(?<ms>\\d+)\\s*ms|whisper|\\/whisper|slow|\\/slow|fast|\\/fast|spell|\\/spell|volume\\s+(?<volume>\\d+(?:\\.\\d+)?)|\\/volume|pitch\\s+(?<pitch>-?\\d+)|\\/pitch|emotion\\s*:\\s*(?<emotion>[a-z][a-z_-]*)|\\/emotion|laugh|sigh|emphasis)\\s*>";
var TAG_RE = new RegExp(EMOTION_TAG_PATTERN, "gi");
var STRIP_RE = new RegExp(EMOTION_TAG_PATTERN, "gi");
var MAX_BREAK_MS = 5e3;
var MAX_TOTAL_BREAK_MS = 1e4;
function stripEmotionTags(raw) {
  return String(raw).replace(STRIP_RE, " ");
}
function parseEmotionTags(raw) {
  const input = String(raw);
  const out = [];
  let buf = "";
  let whisper = false;
  let slow = false;
  let fast = false;
  let spell = false;
  let volume;
  let pitch;
  let emotion;
  let pendingBreakMs = 0;
  let totalBreakMs = 0;
  let sawInlineTag = false;
  const appendText = (chunk) => {
    if (chunk.length === 0)
      return;
    if (sawInlineTag && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(chunk)) {
      buf += " ";
    }
    sawInlineTag = false;
    buf += chunk;
  };
  const flush = () => {
    const text = buf.trim();
    buf = "";
    sawInlineTag = false;
    if (text.length === 0)
      return;
    const seg = { text, whisper };
    if (slow)
      seg.slow = true;
    if (fast)
      seg.fast = true;
    if (spell)
      seg.spell = true;
    if (volume !== void 0)
      seg.volume = volume;
    if (pitch !== void 0)
      seg.pitch = pitch;
    if (emotion)
      seg.emotion = emotion;
    out.push(seg);
  };
  const clampVolume = (value) => Math.min(2, Math.max(0, value));
  const clampPitch = (value) => Math.min(12, Math.max(-12, value));
  let lastEnd = 0;
  for (const m of input.matchAll(TAG_RE)) {
    const idx = m.index ?? 0;
    appendText(input.slice(lastEnd, idx));
    lastEnd = idx + m[0].length;
    const tag = (m[1] ?? "").toLowerCase().trim();
    if (tag.startsWith("break")) {
      const rawMs = Number(m.groups?.ms ?? 0);
      if (!Number.isFinite(rawMs) || rawMs <= 0) {
        sawInlineTag = true;
        continue;
      }
      const remaining = Math.max(0, MAX_TOTAL_BREAK_MS - totalBreakMs);
      const ms = Math.min(rawMs, MAX_BREAK_MS, remaining);
      if (ms <= 0) {
        if (buf.trim().length > 0)
          flush();
        continue;
      }
      totalBreakMs += ms;
      if (buf.trim().length > 0)
        flush();
      const last = out[out.length - 1];
      if (last) {
        last.preBreakMs = (last.preBreakMs ?? 0) + ms;
      } else {
        pendingBreakMs += ms;
      }
    } else if (tag === "whisper") {
      flush();
      whisper = true;
    } else if (tag === "/whisper") {
      flush();
      whisper = false;
    } else if (tag === "slow") {
      flush();
      slow = true;
      fast = false;
    } else if (tag === "/slow") {
      flush();
      slow = false;
    } else if (tag === "fast") {
      flush();
      fast = true;
      slow = false;
    } else if (tag === "/fast") {
      flush();
      fast = false;
    } else if (tag === "spell") {
      flush();
      spell = true;
    } else if (tag === "/spell") {
      flush();
      spell = false;
    } else if (tag.startsWith("volume")) {
      const raw2 = Number(m.groups?.volume ?? NaN);
      if (!Number.isFinite(raw2)) {
        sawInlineTag = true;
        continue;
      }
      flush();
      volume = clampVolume(raw2);
    } else if (tag === "/volume") {
      flush();
      volume = void 0;
    } else if (tag.startsWith("pitch")) {
      const raw2 = Number(m.groups?.pitch ?? NaN);
      if (!Number.isFinite(raw2)) {
        sawInlineTag = true;
        continue;
      }
      flush();
      pitch = clampPitch(raw2);
    } else if (tag === "/pitch") {
      flush();
      pitch = void 0;
    } else if (tag.startsWith("emotion")) {
      const name = (m.groups?.emotion ?? "").toLowerCase();
      flush();
      emotion = EMOTION_NAMES.includes(name) ? name : void 0;
    } else if (tag === "/emotion") {
      flush();
      emotion = void 0;
    } else {
      sawInlineTag = true;
    }
  }
  appendText(input.slice(lastEnd));
  flush();
  if (pendingBreakMs > 0) {
    const first = out[0];
    if (first) {
      first.preBreakMs = (first.preBreakMs ?? 0) + pendingBreakMs;
    }
    pendingBreakMs = 0;
  }
  if (whisper)
    for (const seg of out)
      seg.whisper = false;
  if (slow)
    for (const seg of out)
      delete seg.slow;
  if (fast)
    for (const seg of out)
      delete seg.fast;
  if (spell)
    for (const seg of out)
      delete seg.spell;
  if (volume !== void 0)
    for (const seg of out)
      delete seg.volume;
  if (pitch !== void 0)
    for (const seg of out)
      delete seg.pitch;
  if (emotion)
    for (const seg of out)
      delete seg.emotion;
  return out;
}
var DEFAULT_PROMPT_MAX_BREAK_MS = 1500;
var INLINE_CUE_RE = /<\s*(laugh|sigh|emphasis)\s*>/gi;
var ANY_EMOTION_CUE_RE = new RegExp(EMOTION_TAG_PATTERN, "i");
function buildEmotionPromptInstruction(options = {}) {
  const allowWhisper = options.allowWhisper ?? true;
  const allowBreaks = options.allowBreaks ?? true;
  const allowRoleplayNarration = options.allowRoleplayNarration ?? false;
  const rawMax = options.maxBreakMs ?? DEFAULT_PROMPT_MAX_BREAK_MS;
  const maxBreakMs = typeof rawMax === "number" && Number.isFinite(rawMax) ? Math.min(MAX_BREAK_MS, Math.max(100, Math.round(rawMax))) : DEFAULT_PROMPT_MAX_BREAK_MS;
  const parts = [
    allowRoleplayNarration ? "Write natural spoken dialogue without Markdown code fences or bullet lists; apply emotion tags only to spoken dialogue." : "Write natural spoken dialogue without Markdown formatting, bullet symbols, code fences, or stage-direction asterisks."
  ];
  if (allowWhisper) {
    parts.push("For hushed or confidential phrases, wrap the phrase in balanced <whisper>...</whisper> tags and always close </whisper>.");
  }
  if (allowBreaks) {
    parts.push(`For natural hesitation or dramatic beats, insert <break 300ms> (up to <break ${maxBreakMs}ms>).`);
  }
  if (allowWhisper || allowBreaks) {
    parts.push("Use inline cues (<laugh>, <sigh>, <emphasis>) sparingly; never invent unsupported tags.");
    parts.push("Optional scoped cues: <slow>...</slow>, <fast>...</fast>, <spell>...</spell>, <volume 0.5>...</volume>, <pitch -2>...</pitch>, <emotion:gentle>...</emotion>; always close them.");
  }
  return parts.join(" ");
}
function compileEmotionPlan(raw, mode) {
  const input = String(raw);
  const plainText2 = stripEmotionTags(input).replace(/\s+/g, " ").trim();
  const hasEmotionCues = ANY_EMOTION_CUE_RE.test(input);
  if (mode === "strip") {
    return {
      mode,
      plainText: plainText2,
      segments: plainText2 ? [{ text: plainText2, whisper: false }] : [],
      instructions: "",
      hasEmotionCues
    };
  }
  const segments = parseEmotionTags(input);
  if (mode === "pcm-segments" || !hasEmotionCues) {
    return {
      mode,
      plainText: plainText2,
      segments,
      instructions: "",
      hasEmotionCues
    };
  }
  const hints = [];
  if (segments.some((seg) => seg.whisper)) {
    hints.push("deliver hushed phrases in a soft whisper");
  }
  if (segments.some((seg) => (seg.preBreakMs ?? 0) > 0)) {
    hints.push("leave natural measured pauses between thoughts");
  }
  if (segments.some((seg) => seg.slow)) {
    hints.push("slow the delivery for marked phrases");
  }
  if (segments.some((seg) => seg.fast)) {
    hints.push("quicken the pace for marked phrases");
  }
  if (segments.some((seg) => seg.spell)) {
    hints.push("spell out marked words letter by letter");
  }
  if (segments.some((seg) => seg.volume !== void 0)) {
    hints.push("adjust vocal loudness where marked");
  }
  if (segments.some((seg) => seg.pitch !== void 0)) {
    hints.push("shift pitch where marked");
  }
  const emotionNames = [
    ...new Set(segments.map((seg) => seg.emotion).filter((name) => !!name))
  ];
  if (emotionNames.length > 0) {
    hints.push(`convey the marked emotion (${emotionNames.join(", ")})`);
  }
  const inlineSet = /* @__PURE__ */ new Set();
  for (const match of input.matchAll(INLINE_CUE_RE)) {
    const cue = (match[1] ?? "").toLowerCase();
    if (cue)
      inlineSet.add(cue);
  }
  if (inlineSet.has("laugh"))
    hints.push("include a light natural laugh");
  if (inlineSet.has("sigh"))
    hints.push("include a gentle sigh");
  if (inlineSet.has("emphasis"))
    hints.push("place clear vocal emphasis on key words");
  return {
    mode,
    plainText: plainText2,
    segments,
    instructions: hints.length > 0 ? `Speak naturally: ${hints.join(", ")}.` : "",
    hasEmotionCues
  };
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/redact.js
var PREFIXED = [
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: "$1<redacted>" },
  { re: /\b(Basic\s+)[A-Za-z0-9+/=-]{8,}/gi, to: "$1<redacted>" },
  { re: /\b((?:api[-_]?key|x-api-key)\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, to: "$1<redacted>" },
  { re: /(https?:\/\/)([^:@/\s]+:[^@/\s]+)(@)/gi, to: "$1<redacted>$3" },
  { re: /([?&](?:api[_-]?key|access_token|token|key)=)([^&\s#]+)/gi, to: "$1<redacted>" },
  // Matches both complete JSON string values and values truncated before the closing quote.
  {
    re: /("(?:[a-zA-Z0-9_-]*?(?:api[_-]?key|token|secret|password))"\s*:\s*")([^"\\]{6,})("|$)/gi,
    to: "$1<redacted>$3"
  }
];
var BARE = [
  /\bsk-(?:proj|live|test|ant)-[A-Za-z0-9._-]{8,}/g,
  /\bsk[-_][A-Za-z0-9._-]{8,}/g,
  /\bgsk_[A-Za-z0-9._-]{8,}/g,
  /\brk_(?:live|test)_[A-Za-z0-9._-]{8,}/g,
  /\bAIza[A-Za-z0-9._-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{10,}/g,
  // Mixed-case + digit high-entropy token (>=20 chars); excludes 64-hex SHA256 digests and '/' paths.
  /\b(?![0-9a-fA-F]{64}\b)(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[0-9])[A-Za-z0-9+=_-]{20,}\b/g,
  // 32-hex keys (MD5-shaped secrets); 64-hex SHA256 digests remain intact.
  /\b[0-9a-f]{32}\b/gi
];
function coerceText(value) {
  if (typeof value === "string")
    return value;
  if (value === null || value === void 0)
    return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error)
    return value.message;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
function redactSecrets(text) {
  let out = coerceText(text);
  for (const { re, to } of PREFIXED)
    out = out.replace(re, to);
  for (const re of BARE)
    out = out.replace(re, "<redacted>");
  return out;
}
function redactBodySnippet(body, maxLength = 200) {
  const raw = coerceText(body);
  if (maxLength <= 0)
    return "";
  const preWindow = Math.max(maxLength * 4, 2048);
  return redactSecrets(raw.slice(0, preWindow)).slice(0, maxLength);
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/voice-catalog.js
var MIMO_DEFAULT_BASE_URL = "https://api.xiaomimimo.com/v1";
var MIMO_DEFAULT_MODEL = "mimo-v2.5-tts";
var MIMO_DEFAULT_VOICE = "mimo_default";
var KOKORO_F0 = [
  224,
  189,
  154,
  261,
  226,
  222,
  220,
  229,
  198,
  186,
  212,
  293,
  233,
  161,
  247,
  207,
  218,
  216,
  220,
  238,
  242,
  229,
  198,
  286,
  211,
  190,
  264,
  261,
  226,
  147,
  216,
  240,
  233,
  188,
  222,
  247,
  253,
  270,
  276,
  276,
  279,
  320,
  247,
  296,
  276,
  235,
  139,
  240,
  282,
  282,
  238,
  226,
  273,
  216,
  286,
  270,
  198,
  179,
  117,
  130,
  114,
  128,
  108,
  106,
  122,
  136,
  190,
  112,
  108,
  128,
  131,
  111,
  110,
  132,
  138,
  189,
  137,
  148,
  151,
  127,
  135,
  111,
  138,
  114,
  125,
  158,
  128,
  156,
  132,
  162,
  131,
  136,
  142,
  124,
  129,
  136,
  126,
  135,
  161,
  150,
  124,
  104,
  124
];
var KOKORO_NAMED = {
  48: { name: "zf_xiaobei", zh: "\u5C0F\u5317", en: "Xiaobei" },
  49: { name: "zf_xiaoni", zh: "\u5C0F\u59AE", en: "Xiaoni" },
  50: { name: "zf_xiaoxiao", zh: "\u5C0F\u5C0F", en: "Xiaoxiao" },
  51: { name: "zf_xiaoyi", zh: "\u5C0F\u827A", en: "Xiaoyi" }
};
var KOKORO_PINNED = [62, 68, 75, 76];
var KOKORO_VOICES = [
  ...KOKORO_PINNED.map((sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })),
  ...KOKORO_F0.map((_, sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })).filter((v) => !KOKORO_PINNED.includes(v.sid))
];
var SILICONFLOW_SYSTEM_VOICES = [
  "alex",
  "benjamin",
  "charles",
  "david",
  "anna",
  "bella",
  "claire",
  "diana"
];
var OPENAI_API_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "marin",
  "cedar",
  "nova",
  "onyx",
  "sage",
  "shimmer"
];
var TTS_OPENAI_PRESETS = {
  "siliconflow-cosyvoice2": {
    id: "siliconflow-cosyvoice2",
    label: "SiliconFlow \xB7 CosyVoice2",
    region: "cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/CosyVoice2-0.5B",
    voice: "FunAudioLLM/CosyVoice2-0.5B:alex",
    voices: SILICONFLOW_SYSTEM_VOICES.map((v) => `FunAudioLLM/CosyVoice2-0.5B:${v}`),
    requiresKey: true
  },
  "siliconflow-fish": {
    id: "siliconflow-fish",
    label: "SiliconFlow \xB7 Fish Speech 1.5",
    region: "cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "fishaudio/fish-speech-1.5",
    voice: "fishaudio/fish-speech-1.5:anna",
    voices: SILICONFLOW_SYSTEM_VOICES.map((v) => `fishaudio/fish-speech-1.5:${v}`),
    requiresKey: true
  },
  "openrouter-openai": {
    id: "openrouter-openai",
    label: "OpenRouter \xB7 GPT-4o Mini TTS",
    region: "global",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini-tts-2025-12-15",
    voice: "alloy",
    voices: [...OPENAI_API_VOICES],
    requiresKey: true
  },
  "openai-official": {
    id: "openai-official",
    label: "OpenAI \xB7 GPT-4o Mini TTS",
    region: "global",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
    voice: "marin",
    voices: [...OPENAI_API_VOICES],
    requiresKey: true
  },
  "groq-playai": {
    id: "groq-playai",
    label: "Groq \xB7 PlayAI TTS",
    region: "global",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "playai-tts",
    voice: "Fritz-PlayAI",
    voices: ["Fritz-PlayAI"],
    requiresKey: true
  },
  "selfhosted-kokoro": {
    id: "selfhosted-kokoro",
    label: "Self-hosted \xB7 Kokoro-FastAPI",
    region: "local",
    baseUrl: "http://127.0.0.1:8880/v1",
    model: "kokoro",
    voice: "zf_xiaobei",
    voices: ["zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi"],
    requiresKey: false
  },
  "selfhosted-vllm": {
    id: "selfhosted-vllm",
    label: "Self-hosted \xB7 vLLM-Omni",
    region: "local",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "tts-1",
    voice: "default",
    voices: ["default"],
    requiresKey: false
  }
};
function resolveTtsOpenAiPreset(presetId) {
  return Object.hasOwn(TTS_OPENAI_PRESETS, presetId) ? TTS_OPENAI_PRESETS[presetId] : null;
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/contracts.js
var DEFAULT_ENDPOINT_POLICY = {
  silenceMs: 1500,
  maxSpeechSec: 60,
  vadThreshold: 0.5,
  detectVadThreshold: 0.35
};
function resolveEndpointPolicy(partial = {}) {
  const clamp = (val, min, max, fallback) => {
    if (typeof val !== "number" || !Number.isFinite(val))
      return fallback;
    return Math.min(max, Math.max(min, val));
  };
  return {
    silenceMs: clamp(partial.silenceMs, 200, 1e4, DEFAULT_ENDPOINT_POLICY.silenceMs),
    maxSpeechSec: clamp(partial.maxSpeechSec, 5, 300, DEFAULT_ENDPOINT_POLICY.maxSpeechSec),
    vadThreshold: clamp(partial.vadThreshold, 0.05, 0.99, DEFAULT_ENDPOINT_POLICY.vadThreshold),
    detectVadThreshold: clamp(partial.detectVadThreshold, 0.05, 0.99, DEFAULT_ENDPOINT_POLICY.detectVadThreshold)
  };
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/http-stream.js
var UTF8_DECODER = new TextDecoder("utf-8");
function scheduleTimeout(callback, ms) {
  const fn = typeof setTimeout === "function" ? setTimeout : void 0;
  if (!fn) {
    throw new Error("Timer API is unavailable in this runtime");
  }
  return fn(callback, ms);
}
function cancelTimeout(id) {
  const fn = typeof clearTimeout === "function" ? clearTimeout : void 0;
  if (fn && id !== void 0) {
    fn(id);
  }
}
function resolveFetchImpl(fetchImpl) {
  return fetchImpl ?? fetch;
}
function toError(reason, fallbackMessage = "aborted") {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(fallbackMessage);
}
function raceAbort(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(toError(signal.reason));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(toError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((val) => {
      signal.removeEventListener("abort", onAbort);
      resolve(val);
    }, (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(toError(err, "request failed"));
    });
  });
}
async function resolveSecretValue(provider) {
  if (typeof provider === "string")
    return provider.trim();
  if (typeof provider === "function") {
    const val = await provider();
    return typeof val === "string" ? val.trim() : "";
  }
  return "";
}
async function readBoundedStreamBytes(res, maxBytes, signal, createTooLargeError) {
  const declaredLen = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    await res.body?.cancel().catch(() => void 0);
    throw createTooLargeError();
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    const ab = await raceAbort(res.arrayBuffer(), signal);
    if (ab.byteLength > maxBytes) {
      throw createTooLargeError();
    }
    return new Uint8Array(ab);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done)
        break;
      if (!value || value.byteLength === 0)
        continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => void 0);
        throw createTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
async function readRedactedHttpErrorMessage(res, maxErrorBytes, maxMessageChars, signal) {
  const prefix = `HTTP ${res.status}`;
  try {
    let rawText = "";
    if (!res.body || typeof res.body.getReader !== "function") {
      const ab = await raceAbort(res.arrayBuffer(), signal);
      rawText = UTF8_DECODER.decode(new Uint8Array(ab, 0, Math.min(ab.byteLength, maxErrorBytes)));
    } else {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (total < maxErrorBytes) {
          const { done, value } = await raceAbort(reader.read(), signal);
          if (done || !value)
            break;
          const take = Math.min(value.byteLength, maxErrorBytes - total);
          if (take > 0) {
            chunks.push(value.subarray(0, take));
            total += take;
          }
          if (total >= maxErrorBytes) {
            await reader.cancel().catch(() => void 0);
          }
        }
      } finally {
        reader.releaseLock();
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.byteLength;
      }
      rawText = UTF8_DECODER.decode(merged);
    }
    const redacted = redactSecrets(rawText).replace(/\s+/g, " ").trim();
    if (!redacted)
      return prefix;
    return `${prefix}: ${redacted}`.slice(0, maxMessageChars);
  } catch {
    return prefix;
  }
}
function mergeFloat32Chunks(chunks, totalSamples) {
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/llm-router.js
var LlmRouterError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "LlmRouterError";
    this.code = code;
    this.status = status;
  }
};
var p = (id, label, protocol, defaultBaseUrl, defaultModel, requiresKey) => ({ id, label, protocol, defaultBaseUrl, defaultModel, requiresKey });
var LLM_PRESETS = {
  deepseek: p("deepseek", "DeepSeek", "openai-compat", "https://api.deepseek.com/v1", "deepseek-chat", true),
  "dashscope-qwen": p("dashscope-qwen", "DashScope (Qwen)", "openai-compat", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", true),
  "volcengine-doubao": p("volcengine-doubao", "Volcengine Ark (Doubao)", "openai-compat", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1-6-250615", true),
  "moonshot-kimi": p("moonshot-kimi", "Moonshot (Kimi)", "openai-compat", "https://api.moonshot.cn/v1", "moonshot-v1-8k", true),
  siliconflow: p("siliconflow", "SiliconFlow", "openai-compat", "https://api.siliconflow.cn/v1", "Qwen/Qwen2.5-7B-Instruct", true),
  openrouter: p("openrouter", "OpenRouter", "openai-compat", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini", true),
  openai: p("openai", "OpenAI", "openai-compat", "https://api.openai.com/v1", "gpt-4o-mini", true),
  anthropic: p("anthropic", "Anthropic", "anthropic-messages", "https://api.anthropic.com/v1", "claude-sonnet-4-5", true),
  ollama: p("ollama", "Ollama (Local)", "openai-compat", "http://127.0.0.1:11434/v1", "qwen2.5:7b", false),
  lmstudio: p("lmstudio", "LM Studio (Local)", "openai-compat", "http://127.0.0.1:1234/v1", "local-model", false),
  custom: p("custom", "Custom", "openai-compat", "", "", false)
};
var MAX_ERROR_BYTES = 8 * 1024;
var MAX_FALLBACK_CONTENT_LENGTH = 1024 * 1024;
function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1")
    return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(m && Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255);
}
function parseHttpUrl(rawUrl, code, label) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed)
    throw new LlmRouterError(code, `${label} is required`);
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new LlmRouterError(code, `${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new LlmRouterError(code, `${label} must use http or https`);
  if (url.username || url.password)
    throw new LlmRouterError(code, `${label} must not include embedded credentials`);
  return url;
}
function validateLoopbackUrl(rawUrl) {
  const url = parseHttpUrl(rawUrl, "invalid_url", "loopback URL");
  if (!isLoopbackHost(url.hostname))
    throw new LlmRouterError("invalid_url", "URL must target a loopback host");
  return url;
}
function validateEndpointUrl(rawUrl) {
  const url = parseHttpUrl(rawUrl, "bad_url", "baseUrl");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname))
    throw new LlmRouterError("bad_url", "plaintext http is only permitted for loopback hosts");
  return url;
}
var CORRECTION_FILLER_WORDS = "\u5F53\u7136\u53EF\u4EE5|\u5F53\u7136|\u597D\u5427|\u597D\u7684?|\u884C\u5427|\u884C|\u662F\u7684|\u55EF|\u6536\u5230|\u660E\u767D\u4E86|\u77E5\u9053\u4E86|Thank you|Of course|Got it|OK|Okay|Sure|Certainly|Alright|Understood|Hello|Hi|Yes|Thanks";
var CORRECTION_FILLER_PREFIX_RE = new RegExp(`^(?:(?:${CORRECTION_FILLER_WORDS})(?:\\s*[,\uFF0C\u3001:\uFF1A.\u3002!\uFF01?\uFF1F)\uFF09]|\\s))+`, "i");
var CORRECTION_PURE_FILLER_RE = new RegExp(`^(?:(?:${CORRECTION_FILLER_WORDS})(?:\\s*[,\uFF0C\u3001:\uFF1A.\u3002!\uFF01?\uFF1F)\uFF09]\\s*|\\s+))*(?:${CORRECTION_FILLER_WORDS})\\s*$`, "i");

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/tts-engines.js
var MAX_AUDIO_BYTES = 16 * 1024 * 1024;
var MAX_MIMO_JSON_BYTES = 24 * 1024 * 1024;
var MAX_TTS_ERROR_BYTES = 8 * 1024;
var MAX_ERROR_MESSAGE_CHARS = 240;
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_COOLDOWN_MS = 6e4;
var UTF8_DECODER2 = new TextDecoder("utf-8");
var TtsProviderError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(redactSecrets(message));
    this.name = "TtsProviderError";
    this.code = code;
    if (status !== void 0) {
      this.status = status;
    }
  }
};
function sniffAudioMime(bytes, contentTypeHeader) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    return null;
  if (bytes.byteLength >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 65 && bytes[10] === 86 && bytes[11] === 69) {
    return "audio/wav";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51) {
    return "audio/mpeg";
  }
  if (bytes.byteLength >= 2 && bytes[0] === 255) {
    const b1 = bytes[1];
    if ((b1 & 224) === 224 && (b1 & 24) !== 8 && (b1 & 6) !== 0) {
      return "audio/mpeg";
    }
  }
  if (bytes.byteLength >= 4 && bytes[0] === 79 && bytes[1] === 103 && bytes[2] === 103 && bytes[3] === 83) {
    return "audio/ogg";
  }
  if (bytes.byteLength >= 4 && bytes[0] === 102 && bytes[1] === 76 && bytes[2] === 97 && bytes[3] === 67) {
    return "audio/flac";
  }
  if (bytes.byteLength >= 4 && bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) {
    return "audio/webm";
  }
  if (bytes.byteLength >= 8 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112) {
    return "audio/mp4";
  }
  if (!contentTypeHeader || typeof contentTypeHeader !== "string")
    return null;
  const mediaType = (contentTypeHeader.split(";")[0] ?? "").trim().toLowerCase();
  if (!/^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType))
    return null;
  const prefix = UTF8_DECODER2.decode(bytes.subarray(0, 64)).trimStart();
  if (prefix.startsWith("<") || prefix.startsWith("{") || prefix.startsWith("[")) {
    return null;
  }
  return mediaType;
}
var B64_TABLE = (() => {
  const table = new Int8Array(128).fill(-1);
  const std = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < std.length; i += 1) {
    table[std.charCodeAt(i)] = i;
  }
  table[45] = 62;
  table[95] = 63;
  return table;
})();
function lookupB64(code) {
  if (code < 0 || code >= 128)
    return -1;
  return B64_TABLE[code];
}
function decodeBase64Strict(raw) {
  if (typeof raw !== "string") {
    throw new TtsProviderError("bad_audio_payload", "Base64 audio payload must be a string");
  }
  const clean = /[ \t\r\n]/.test(raw) ? raw.replace(/[ \t\r\n]+/g, "") : raw;
  if (clean.length === 0) {
    throw new TtsProviderError("bad_audio_payload", "Base64 audio payload is empty");
  }
  let padCount = 0;
  while (padCount < clean.length && clean.charCodeAt(clean.length - 1 - padCount) === 61) {
    padCount += 1;
  }
  if (padCount > 2 || padCount > 0 && clean.length % 4 !== 0) {
    throw new TtsProviderError("bad_audio_payload", "Invalid base64 padding in audio payload");
  }
  const dataLen = clean.length - padCount;
  if (dataLen === 0 || dataLen % 4 === 1) {
    throw new TtsProviderError("bad_audio_payload", "Invalid base64 length in audio payload");
  }
  const fullQuads = Math.floor(dataLen / 4);
  const rem = dataLen % 4;
  const outLen = fullQuads * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  if (outLen === 0) {
    throw new TtsProviderError("bad_audio_payload", "Decoded audio payload is empty");
  }
  const out = new Uint8Array(outLen);
  let inPos = 0;
  let outPos = 0;
  for (let q = 0; q < fullQuads; q += 1) {
    const b0 = lookupB64(clean.charCodeAt(inPos));
    const b1 = lookupB64(clean.charCodeAt(inPos + 1));
    const b2 = lookupB64(clean.charCodeAt(inPos + 2));
    const b3 = lookupB64(clean.charCodeAt(inPos + 3));
    if ((b0 | b1 | b2 | b3) < 0) {
      throw new TtsProviderError("bad_audio_payload", "Corrupt base64 character in audio payload");
    }
    out[outPos] = b0 << 2 | b1 >> 4;
    out[outPos + 1] = (b1 & 15) << 4 | b2 >> 2;
    out[outPos + 2] = (b2 & 3) << 6 | b3;
    inPos += 4;
    outPos += 3;
  }
  if (rem === 2) {
    const b0 = lookupB64(clean.charCodeAt(inPos));
    const b1 = lookupB64(clean.charCodeAt(inPos + 1));
    if ((b0 | b1) < 0) {
      throw new TtsProviderError("bad_audio_payload", "Corrupt base64 character in audio payload");
    }
    out[outPos] = b0 << 2 | b1 >> 4;
  } else if (rem === 3) {
    const b0 = lookupB64(clean.charCodeAt(inPos));
    const b1 = lookupB64(clean.charCodeAt(inPos + 1));
    const b2 = lookupB64(clean.charCodeAt(inPos + 2));
    if ((b0 | b1 | b2) < 0) {
      throw new TtsProviderError("bad_audio_payload", "Corrupt base64 character in audio payload");
    }
    out[outPos] = b0 << 2 | b1 >> 4;
    out[outPos + 1] = (b1 & 15) << 4 | b2 >> 2;
  }
  return out;
}
function buildValidatedEndpoint(rawBaseUrl, suffix) {
  let url;
  try {
    url = validateEndpointUrl(rawBaseUrl);
  } catch (err) {
    throw new TtsProviderError("bad_url", err instanceof Error ? err.message : String(err));
  }
  const noSlash = url.pathname.replace(/\/+$/, "");
  const basePath = noSlash.endsWith(suffix) ? noSlash.slice(0, -suffix.length) : noSlash;
  url.pathname = `${basePath}${suffix}`;
  return {
    baseUrl: `${url.origin}${basePath}`,
    url: url.toString()
  };
}
function resolveOpenAiTtsConfig(input = {}) {
  const rawPresetId = input.presetId?.trim() ?? "";
  const rawBaseUrl = input.baseUrl?.trim() ?? "";
  const preset = rawPresetId ? resolveTtsOpenAiPreset(rawPresetId) : rawBaseUrl ? null : TTS_OPENAI_PRESETS["openai-official"] ?? null;
  const effectiveBase = rawBaseUrl || preset?.baseUrl || "";
  const { baseUrl, url } = buildValidatedEndpoint(effectiveBase, "/audio/speech");
  const model = input.model?.trim() || preset?.model || "tts-1";
  const voice = input.voice !== void 0 ? input.voice.trim() : preset?.voice ?? "";
  const isLoopbackOverride = rawBaseUrl.length > 0 && url.startsWith("http://");
  return {
    preset,
    presetId: preset?.id ?? (rawPresetId || "custom"),
    baseUrl,
    url,
    model,
    voice,
    requiresKey: preset && !isLoopbackOverride ? preset.requiresKey : false
  };
}
var HttpTtsEngineBase = class {
  timeoutMs;
  cooldownMs;
  fetchImpl;
  now;
  fallbackFactory;
  voiceOverride;
  defaultRate;
  cachedKeyPresent;
  lastError = null;
  cooldownUntil = 0;
  closed = false;
  fallbackEngine = null;
  inflight = /* @__PURE__ */ new Set();
  constructor(opts) {
    this.timeoutMs = typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.cooldownMs = typeof opts.cooldownMs === "number" && Number.isFinite(opts.cooldownMs) && opts.cooldownMs >= 0 ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
    this.fetchImpl = resolveFetchImpl(opts.fetchImpl);
    this.now = opts.now ?? Date.now;
    if (opts.fallback) {
      this.fallbackFactory = opts.fallback;
    }
  }
  updateVoice(voice, rate) {
    this.voiceOverride = voice.trim();
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate;
    }
  }
  interrupt() {
    for (const handle of this.inflight) {
      handle.markInterrupted();
      handle.ac.abort(new Error("TTS interrupted"));
    }
    this.inflight.clear();
    this.fallbackEngine?.interrupt?.();
  }
  async close() {
    this.closed = true;
    this.interrupt();
    if (this.fallbackEngine) {
      const fb = this.fallbackEngine;
      this.fallbackEngine = null;
      await fb.close();
    }
  }
  async synthesize(text, options) {
    if (this.closed) {
      throw new TtsProviderError("aborted", "TTS engine is closed");
    }
    if (options?.signal?.aborted) {
      throw new TtsProviderError("aborted", "TTS synthesis was aborted");
    }
    const cleaned = stripEmotionTags(text).trim();
    if (cleaned.length === 0) {
      return { audio: new Uint8Array(0), mime: this.mime };
    }
    if (this.fallbackFactory && this.cooldownMs > 0 && this.now() < this.cooldownUntil) {
      return this.synthesizeViaFallback(text, options);
    }
    const ac = new AbortController();
    let timedOut = false;
    let interrupted = false;
    let callerAborted = false;
    const handle = {
      ac,
      markInterrupted: () => {
        interrupted = true;
      }
    };
    this.inflight.add(handle);
    const onCallerAbort = () => {
      callerAborted = true;
      ac.abort(options?.signal?.reason ?? new Error("aborted"));
    };
    options?.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = scheduleTimeout(() => {
      timedOut = true;
      ac.abort(new Error("TTS request timed out"));
    }, this.timeoutMs);
    try {
      const result = await this.synthesizePrimary(cleaned, options, ac.signal);
      if (interrupted || callerAborted || options?.signal?.aborted) {
        throw new TtsProviderError("aborted", "TTS synthesis was aborted");
      }
      this.cooldownUntil = 0;
      this.lastError = null;
      return result;
    } catch (rawErr) {
      let err;
      if (interrupted || callerAborted || options?.signal?.aborted) {
        err = new TtsProviderError("aborted", "TTS synthesis was aborted");
      } else if (timedOut) {
        err = new TtsProviderError("timeout", `TTS request timed out after ${this.timeoutMs} ms`);
      } else if (rawErr instanceof TtsProviderError) {
        err = rawErr;
      } else {
        err = new TtsProviderError("network", rawErr instanceof Error ? rawErr.message : String(rawErr));
      }
      if (err.code === "aborted" || err.code === "bad_url") {
        throw err;
      }
      this.lastError = err;
      if (this.fallbackFactory) {
        if (this.cooldownMs > 0) {
          this.cooldownUntil = this.now() + this.cooldownMs;
        }
        return this.synthesizeViaFallback(text, options);
      }
      throw err;
    } finally {
      cancelTimeout(timer);
      options?.signal?.removeEventListener("abort", onCallerAbort);
      this.inflight.delete(handle);
    }
  }
  synthesizeViaFallback(text, options) {
    if (!this.fallbackEngine) {
      this.fallbackEngine = this.fallbackFactory();
    }
    const fallbackOpts = {};
    if (options?.voice !== void 0)
      fallbackOpts.voice = options.voice;
    const rate = options?.rate ?? this.defaultRate;
    if (rate !== void 0)
      fallbackOpts.rate = rate;
    if (options?.signal !== void 0)
      fallbackOpts.signal = options.signal;
    return this.fallbackEngine.synthesize(text, fallbackOpts);
  }
};
var OpenAiCompatTtsEngine = class extends HttpTtsEngineBase {
  kind = "openai-compat";
  mime;
  rawOptions;
  responseFormat;
  constructor(options = {}) {
    super(options);
    this.rawOptions = options;
    this.responseFormat = options.responseFormat ?? "mp3";
    this.mime = this.responseFormat === "wav" ? "audio/wav" : "audio/mpeg";
    if (typeof options.apiKey === "string") {
      this.cachedKeyPresent = options.apiKey.trim().length > 0;
    }
  }
  async prepare() {
    const resolved = resolveOpenAiTtsConfig(this.rawOptions);
    const key = await resolveSecretValue(this.rawOptions.apiKey);
    this.cachedKeyPresent = key.length > 0;
    if (resolved.requiresKey && !key) {
      throw new TtsProviderError("not_configured", `TTS preset "${resolved.presetId}" requires a non-empty apiKey`);
    }
  }
  status() {
    try {
      const cfg = resolveOpenAiTtsConfig(this.rawOptions);
      const keyPresent = typeof this.rawOptions.apiKey === "string" ? this.rawOptions.apiKey.trim().length > 0 : this.cachedKeyPresent ?? false;
      const status = {
        engine: this.kind,
        ready: !this.closed && (!cfg.requiresKey || keyPresent),
        loading: this.inflight.size > 0,
        keyRequired: cfg.requiresKey,
        keyPresent
      };
      if (this.lastError) {
        status.error = this.lastError.message;
        status.errorCode = this.lastError.code;
      }
      return status;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        engine: this.kind,
        ready: false,
        loading: false,
        error: redactSecrets(msg),
        errorCode: err instanceof TtsProviderError ? err.code : "bad_url"
      };
    }
  }
  async synthesizePrimary(cleanedText, options, signal) {
    const resolved = resolveOpenAiTtsConfig(this.rawOptions);
    const trimmedKey = await resolveSecretValue(this.rawOptions.apiKey);
    this.cachedKeyPresent = trimmedKey.length > 0;
    if (resolved.requiresKey && !trimmedKey) {
      throw new TtsProviderError("not_configured", `TTS preset "${resolved.presetId}" requires a non-empty apiKey`);
    }
    const effectiveVoice = options?.voice !== void 0 ? options.voice.trim() : this.voiceOverride !== void 0 ? this.voiceOverride : resolved.voice;
    const effectiveRate = options?.rate ?? this.defaultRate;
    const payload = {
      model: resolved.model,
      input: cleanedText,
      response_format: this.responseFormat
    };
    if (effectiveVoice.length > 0) {
      payload.voice = effectiveVoice;
    }
    if (typeof effectiveRate === "number" && Number.isFinite(effectiveRate) && effectiveRate > 0 && effectiveRate !== 1) {
      payload.speed = effectiveRate;
    }
    const instructions = this.rawOptions.instructions?.trim();
    if (instructions) {
      payload.instructions = instructions;
    }
    const headers = {
      "Content-Type": "application/json"
    };
    if (trimmedKey.length > 0) {
      headers.Authorization = `Bearer ${trimmedKey}`;
    }
    const res = await raceAbort(this.fetchImpl(resolved.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
      redirect: "error"
    }), signal);
    if (!res.ok) {
      const msg = await readRedactedHttpErrorMessage(res, MAX_TTS_ERROR_BYTES, MAX_ERROR_MESSAGE_CHARS, signal);
      throw new TtsProviderError("http_error", msg, res.status);
    }
    const audio = await readBoundedStreamBytes(res, MAX_AUDIO_BYTES, signal, () => new TtsProviderError("too_large", `TTS audio response exceeds ${MAX_AUDIO_BYTES} bytes`));
    if (audio.byteLength === 0) {
      throw new TtsProviderError("bad_audio_payload", "TTS provider returned empty audio payload");
    }
    const sniffed = sniffAudioMime(audio, res.headers.get("content-type") ?? void 0);
    if (!sniffed) {
      throw new TtsProviderError("bad_audio_payload", "TTS provider returned unrecognized or non-audio payload");
    }
    return { audio, mime: sniffed };
  }
};
function formatMimoSpeedPrompt(rate) {
  const formatted = Number(rate.toFixed(2));
  if (rate > 1) {
    return `Please speak at a faster pace (${formatted}x speed\uFF0C\u8BED\u901F\u52A0\u5FEB\u81F3\u7EA6 ${formatted} \u500D).`;
  }
  return `Please speak at a slower pace (${formatted}x speed\uFF0C\u8BED\u901F\u653E\u6162\u81F3\u7EA6 ${formatted} \u500D).`;
}
var MimoTtsEngine = class extends HttpTtsEngineBase {
  kind = "mimo";
  mime;
  rawOptions;
  responseFormat;
  constructor(options = {}) {
    super(options);
    this.rawOptions = options;
    this.responseFormat = options.responseFormat ?? "wav";
    this.mime = this.responseFormat === "mp3" ? "audio/mpeg" : "audio/wav";
    if (typeof options.apiKey === "string") {
      this.cachedKeyPresent = options.apiKey.trim().length > 0;
    }
  }
  resolveUrl() {
    const rawBase = this.rawOptions.baseUrl?.trim() || MIMO_DEFAULT_BASE_URL;
    return buildValidatedEndpoint(rawBase, "/chat/completions").url;
  }
  async prepare() {
    this.resolveUrl();
    const key = await resolveSecretValue(this.rawOptions.apiKey);
    this.cachedKeyPresent = key.length > 0;
    if (!key) {
      throw new TtsProviderError("not_configured", "MiMo TTS requires a non-empty apiKey");
    }
  }
  status() {
    try {
      this.resolveUrl();
      const keyPresent = typeof this.rawOptions.apiKey === "string" ? this.rawOptions.apiKey.trim().length > 0 : this.cachedKeyPresent ?? false;
      const status = {
        engine: this.kind,
        ready: !this.closed && keyPresent,
        loading: this.inflight.size > 0,
        keyRequired: true,
        keyPresent
      };
      if (this.lastError) {
        status.error = this.lastError.message;
        status.errorCode = this.lastError.code;
      }
      return status;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        engine: this.kind,
        ready: false,
        loading: false,
        keyRequired: true,
        keyPresent: false,
        error: redactSecrets(msg),
        errorCode: err instanceof TtsProviderError ? err.code : "bad_url"
      };
    }
  }
  async synthesizePrimary(cleanedText, options, signal) {
    const url = this.resolveUrl();
    const trimmedKey = await resolveSecretValue(this.rawOptions.apiKey);
    this.cachedKeyPresent = trimmedKey.length > 0;
    if (!trimmedKey) {
      throw new TtsProviderError("not_configured", "MiMo TTS requires a non-empty apiKey");
    }
    const effectiveVoice = (options?.voice !== void 0 ? options.voice.trim() : void 0) || this.voiceOverride || this.rawOptions.voice?.trim() || MIMO_DEFAULT_VOICE;
    const effectiveRate = options?.rate ?? this.defaultRate;
    const hasCustomRate = typeof effectiveRate === "number" && Number.isFinite(effectiveRate) && effectiveRate > 0 && effectiveRate !== 1;
    const userPrompts = [];
    const instructions = this.rawOptions.instructions?.trim();
    if (instructions) {
      userPrompts.push(instructions);
    }
    if (hasCustomRate) {
      userPrompts.push(formatMimoSpeedPrompt(effectiveRate));
    }
    const messages = [];
    if (userPrompts.length > 0) {
      messages.push({ role: "user", content: userPrompts.join("\n") });
    }
    messages.push({ role: "assistant", content: cleanedText });
    const model = this.rawOptions.model?.trim() || MIMO_DEFAULT_MODEL;
    const payload = {
      model,
      messages,
      audio: {
        voice: effectiveVoice,
        format: this.responseFormat
      },
      stream: false
    };
    const headers = {
      "Content-Type": "application/json",
      "api-key": trimmedKey
    };
    const res = await raceAbort(this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
      redirect: "error"
    }), signal);
    if (!res.ok) {
      const msg = await readRedactedHttpErrorMessage(res, MAX_TTS_ERROR_BYTES, MAX_ERROR_MESSAGE_CHARS, signal);
      throw new TtsProviderError("http_error", msg, res.status);
    }
    const rawBytes = await readBoundedStreamBytes(res, MAX_MIMO_JSON_BYTES, signal, () => new TtsProviderError("too_large", `MiMo JSON response exceeds ${MAX_MIMO_JSON_BYTES} bytes`));
    const rawJson = UTF8_DECODER2.decode(rawBytes);
    let parsed;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      const snippet = redactSecrets(rawJson.slice(0, MAX_TTS_ERROR_BYTES)).replace(/\s+/g, " ").trim();
      throw new TtsProviderError("bad_audio_payload", `MiMo returned non-JSON body: ${snippet}`.slice(0, MAX_ERROR_MESSAGE_CHARS));
    }
    const root = typeof parsed === "object" && parsed !== null ? parsed : null;
    const firstChoice = Array.isArray(root?.choices) ? root.choices[0] : void 0;
    const b64Data = firstChoice?.message?.audio?.data;
    if (typeof b64Data !== "string" || b64Data.trim().length === 0) {
      const errDetail = root?.error ? `: ${redactSecrets(JSON.stringify(root.error).slice(0, MAX_TTS_ERROR_BYTES))}` : "";
      throw new TtsProviderError("bad_audio_payload", `MiMo response missing choices[0].message.audio.data${errDetail}`.slice(0, MAX_ERROR_MESSAGE_CHARS));
    }
    const audio = decodeBase64Strict(b64Data);
    const declaredMime = this.responseFormat === "mp3" ? "audio/mpeg" : "audio/wav";
    const sniffed = sniffAudioMime(audio, declaredMime);
    if (!sniffed) {
      throw new TtsProviderError("bad_audio_payload", "MiMo returned unrecognized or non-audio payload");
    }
    return { audio, mime: sniffed };
  }
};

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/asr-engines.js
var DEFAULT_ASR_OPENAI_BASE_URL = "https://api.openai.com/v1";
var DEFAULT_ASR_OPENAI_MODEL = "whisper-1";
var MAX_ASR_AUDIO_BYTES = 25 * 1024 * 1024;
var MAX_ASR_RESPONSE_BYTES = 1 * 1024 * 1024;
var MAX_ASR_ERROR_BYTES = 8 * 1024;
var MAX_ERROR_MESSAGE_CHARS2 = 240;
var DEFAULT_ASR_TIMEOUT_MS = 45e3;
var DEFAULT_SAMPLE_RATE = 16e3;
var TRANSCRIPTIONS_SUFFIX = "/audio/transcriptions";
var UTF8_ENCODER2 = new TextEncoder();
var UTF8_DECODER3 = new TextDecoder("utf-8");
var AsrProviderError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(redactSecrets(message));
    this.name = "AsrProviderError";
    this.code = code;
    if (status !== void 0) {
      this.status = status;
    }
  }
};
function resolveTranscriptionsEndpointUrl(baseUrl) {
  const rawBase = typeof baseUrl === "string" ? baseUrl.trim() : "";
  let parsed;
  try {
    parsed = validateEndpointUrl(rawBase || DEFAULT_ASR_OPENAI_BASE_URL);
  } catch (err) {
    throw new AsrProviderError("bad_url", err instanceof Error ? err.message : String(err));
  }
  let basePath = parsed.pathname.replace(/\/+$/, "");
  while (basePath.endsWith(TRANSCRIPTIONS_SUFFIX)) {
    basePath = basePath.slice(0, -TRANSCRIPTIONS_SUFFIX.length).replace(/\/+$/, "");
  }
  parsed.pathname = `${basePath}${TRANSCRIPTIONS_SUFFIX}`;
  const url = parsed.toString();
  return {
    baseUrl: `${parsed.origin}${basePath}`,
    url,
    isLoopbackHttp: url.startsWith("http://")
  };
}
function decodeMonoPcm16Wav(input) {
  if (input.byteLength < 44)
    return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const tag = (offset2) => String.fromCharCode(input[offset2] ?? 0, input[offset2 + 1] ?? 0, input[offset2 + 2] ?? 0, input[offset2 + 3] ?? 0);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE")
    return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= input.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > input.byteLength)
        return null;
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataStart = body;
      dataSize = Math.min(size, input.byteLength - body);
      break;
    }
    offset = body + size + size % 2;
  }
  if (dataStart < 0 || sampleRate <= 0 || bitsPerSample !== 16 || channels !== 1)
    return null;
  const count = Math.floor(dataSize / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(dataStart + i * 2, true) / 32768;
  }
  return { samples, sampleRate };
}
function mergeMonoPcm16WavChunks(chunks) {
  const decodedChunks = [];
  let sampleRate = 0;
  let skipped = 0;
  for (const chunk of chunks) {
    const decoded = decodeMonoPcm16Wav(chunk);
    if (!decoded) {
      skipped += 1;
      continue;
    }
    if (sampleRate === 0) {
      sampleRate = decoded.sampleRate;
    }
    if (decoded.sampleRate !== sampleRate) {
      skipped += 1;
      continue;
    }
    decodedChunks.push(decoded.samples);
  }
  if (decodedChunks.length === 0)
    return null;
  const totalSamples = decodedChunks.reduce((sum, samples) => sum + samples.length, 0);
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const samples of decodedChunks) {
    merged.set(samples, offset);
    offset += samples.length;
  }
  return {
    wav: encodeMonoPcm16Wav(merged, sampleRate),
    sampleRate,
    merged: decodedChunks.length,
    skipped
  };
}
function encodeMonoPcm16Wav(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  const rate = typeof sampleRate === "number" && Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : DEFAULT_SAMPLE_RATE;
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = 82;
  out[1] = 73;
  out[2] = 70;
  out[3] = 70;
  view.setUint32(4, 36 + dataBytes, true);
  out[8] = 87;
  out[9] = 65;
  out[10] = 86;
  out[11] = 69;
  out[12] = 102;
  out[13] = 109;
  out[14] = 116;
  out[15] = 32;
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out[36] = 100;
  out[37] = 97;
  out[38] = 116;
  out[39] = 97;
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < numSamples; i += 1) {
    const raw = samples[i];
    const clamped = Number.isNaN(raw) ? 0 : raw < -1 ? -1 : raw > 1 ? 1 : raw;
    const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    view.setInt16(44 + i * 2, pcm, true);
  }
  return out;
}
function sanitizeMultipartParam(value) {
  return value.replace(/\\/g, "%5C").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}
function createMultipartBoundary() {
  const rand = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i += 1) {
      rand[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = "";
  for (let i = 0; i < rand.length; i += 1) {
    hex += rand[i].toString(16).padStart(2, "0");
  }
  return `----VoiceModeBoundary${hex}`;
}
function buildMultipartFormData(fields, file) {
  const boundary = createMultipartBoundary();
  const crlf = UTF8_ENCODER2.encode("\r\n");
  const parts = [];
  for (const [rawName, rawValue] of fields) {
    const safeName = sanitizeMultipartParam(rawName);
    const partText = `--${boundary}\r
Content-Disposition: form-data; name="${safeName}"\r
\r
${rawValue}\r
`;
    parts.push(UTF8_ENCODER2.encode(partText));
  }
  const safeFieldName = sanitizeMultipartParam(file.fieldName);
  const safeFileName = sanitizeMultipartParam(file.fileName);
  const safeContentType = (file.contentType || "application/octet-stream").replace(/[\r\n]+/g, " ").trim() || "application/octet-stream";
  const fileHeader = `--${boundary}\r
Content-Disposition: form-data; name="${safeFieldName}"; filename="${safeFileName}"\r
Content-Type: ${safeContentType}\r
\r
`;
  parts.push(UTF8_ENCODER2.encode(fileHeader));
  parts.push(file.bytes);
  parts.push(crlf);
  parts.push(UTF8_ENCODER2.encode(`--${boundary}--\r
`));
  let totalBytes = 0;
  for (const p2 of parts) {
    totalBytes += p2.byteLength;
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p2 of parts) {
    body.set(p2, offset);
    offset += p2.byteLength;
  }
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}
function normalizeWhisperLanguage(locale) {
  if (typeof locale !== "string")
    return void 0;
  const trimmed = locale.trim().toLowerCase();
  if (!trimmed || trimmed === "auto")
    return void 0;
  if (trimmed === "cantonese")
    return "yue";
  const subtags = trimmed.split(/[-_]+/).filter(Boolean);
  const primary = subtags[0];
  if (!primary)
    return void 0;
  if (primary === "yue")
    return "yue";
  if (primary === "zh" && (subtags.includes("hk") || subtags.includes("yue"))) {
    return "yue";
  }
  if (/^[a-z]{2,3}$/.test(primary)) {
    return primary;
  }
  return void 0;
}
var OpenAiCompatAsrTransport = class {
  kind = "openai-compat";
  options;
  timeoutMs;
  maxSpeechSec;
  fetchImpl;
  inflight = /* @__PURE__ */ new Set();
  closed = false;
  chunks = [];
  bufferedSamples = 0;
  sessionMaxSamples;
  sessionLanguage;
  constructor(options = {}) {
    this.options = options;
    this.timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_ASR_TIMEOUT_MS;
    this.maxSpeechSec = typeof options.maxSpeechSec === "number" && Number.isFinite(options.maxSpeechSec) && options.maxSpeechSec > 0 ? options.maxSpeechSec : DEFAULT_ENDPOINT_POLICY.maxSpeechSec;
    this.fetchImpl = resolveFetchImpl(options.fetchImpl);
    this.sessionMaxSamples = Math.max(0, Math.floor(this.maxSpeechSec * DEFAULT_SAMPLE_RATE));
  }
  async start(options) {
    if (this.closed) {
      throw new AsrProviderError("aborted", "ASR transport is closed");
    }
    if (options?.signal?.aborted) {
      throw new AsrProviderError("aborted", "ASR session was aborted");
    }
    const policyMaxSec = options?.policy?.maxSpeechSec;
    const effectiveMaxSec = typeof policyMaxSec === "number" && Number.isFinite(policyMaxSec) && policyMaxSec > 0 ? policyMaxSec : this.maxSpeechSec;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.sessionMaxSamples = Math.max(0, Math.floor(effectiveMaxSec * DEFAULT_SAMPLE_RATE));
    this.sessionLanguage = options?.language;
  }
  pushAudio(pcm16k) {
    if (this.closed || !(pcm16k instanceof Float32Array) || pcm16k.length === 0)
      return;
    const remaining = this.sessionMaxSamples - this.bufferedSamples;
    if (remaining <= 0)
      return;
    const slice = pcm16k.length <= remaining ? pcm16k.slice() : pcm16k.slice(0, remaining);
    this.chunks.push(slice);
    this.bufferedSamples += slice.length;
  }
  async finalize(signal) {
    const merged = mergeFloat32Chunks(this.chunks, this.bufferedSamples);
    const lang = this.sessionLanguage;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.sessionLanguage = void 0;
    const transcribeOpts = {
      sampleRate: DEFAULT_SAMPLE_RATE
    };
    if (lang !== void 0)
      transcribeOpts.language = lang;
    if (signal !== void 0)
      transcribeOpts.signal = signal;
    return this.transcribe(merged, transcribeOpts);
  }
  async transcribe(pcm16k, options) {
    if (this.closed) {
      throw new AsrProviderError("aborted", "ASR transport is closed");
    }
    if (options?.signal?.aborted) {
      throw new AsrProviderError("aborted", "ASR transcription was aborted");
    }
    if (!pcm16k || pcm16k.length === 0) {
      return { text: "", isFinal: true, durationMs: 0 };
    }
    const endpoint = resolveTranscriptionsEndpointUrl(this.options.baseUrl);
    if (44 + pcm16k.length * 2 > MAX_ASR_AUDIO_BYTES) {
      throw new AsrProviderError("too_large", `ASR audio upload exceeds ${MAX_ASR_AUDIO_BYTES} bytes`);
    }
    const ac = new AbortController();
    let timedOut = false;
    let abortedByTransport = false;
    let callerAborted = false;
    const handle = {
      ac,
      markAborted: () => {
        abortedByTransport = true;
      }
    };
    this.inflight.add(handle);
    const onCallerAbort = () => {
      callerAborted = true;
      ac.abort(options?.signal?.reason ?? new Error("aborted"));
    };
    options?.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = scheduleTimeout(() => {
      timedOut = true;
      ac.abort(new Error("ASR request timed out"));
    }, this.timeoutMs);
    try {
      const trimmedKey = await resolveSecretValue(this.options.apiKey);
      if (abortedByTransport || callerAborted || options?.signal?.aborted || this.closed) {
        throw new AsrProviderError("aborted", "ASR transcription was aborted");
      }
      if (!endpoint.isLoopbackHttp && !trimmedKey) {
        throw new AsrProviderError("not_configured", "ASR endpoint requires a non-empty apiKey unless using loopback HTTP");
      }
      const effectiveRate = typeof options?.sampleRate === "number" && Number.isFinite(options.sampleRate) && options.sampleRate > 0 ? Math.round(options.sampleRate) : DEFAULT_SAMPLE_RATE;
      const wav = encodeMonoPcm16Wav(pcm16k, effectiveRate);
      if (wav.byteLength > MAX_ASR_AUDIO_BYTES) {
        throw new AsrProviderError("too_large", `ASR audio upload exceeds ${MAX_ASR_AUDIO_BYTES} bytes`);
      }
      const model = this.options.model?.trim() || DEFAULT_ASR_OPENAI_MODEL;
      const rawLang = options?.language !== void 0 ? options.language : this.options.language;
      const normalizedLang = normalizeWhisperLanguage(rawLang);
      const prompt = this.options.prompt?.trim();
      const fields = [
        ["model", model],
        ["response_format", "json"]
      ];
      if (normalizedLang !== void 0) {
        fields.push(["language", normalizedLang]);
      }
      if (prompt) {
        fields.push(["prompt", prompt]);
      }
      const multipart = buildMultipartFormData(fields, {
        fieldName: "file",
        fileName: "speech.wav",
        contentType: "audio/wav",
        bytes: wav
      });
      const headers = {
        "Content-Type": multipart.contentType
      };
      if (trimmedKey.length > 0) {
        headers.Authorization = `Bearer ${trimmedKey}`;
      }
      const durationMs = Math.round(pcm16k.length / effectiveRate * 1e3);
      const res = await raceAbort(this.fetchImpl(endpoint.url, {
        method: "POST",
        headers,
        body: multipart.body,
        signal: ac.signal,
        redirect: "error"
      }), ac.signal);
      if (!res.ok) {
        const msg = await readRedactedHttpErrorMessage(res, MAX_ASR_ERROR_BYTES, MAX_ERROR_MESSAGE_CHARS2, ac.signal);
        throw new AsrProviderError("http_error", msg, res.status);
      }
      const bodyBytes = await readBoundedStreamBytes(res, MAX_ASR_RESPONSE_BYTES, ac.signal, () => new AsrProviderError("too_large", `ASR transcript response exceeds ${MAX_ASR_RESPONSE_BYTES} bytes`));
      if (abortedByTransport || callerAborted || options?.signal?.aborted) {
        throw new AsrProviderError("aborted", "ASR transcription was aborted");
      }
      const rawText = UTF8_DECODER3.decode(bodyBytes);
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/plain")) {
        return {
          text: rawText.trim(),
          isFinal: true,
          durationMs
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new AsrProviderError("bad_response", `ASR provider returned non-JSON response: ${redactBodySnippet(rawText, 160)}`);
      }
      if (typeof parsed !== "object" || parsed === null || typeof parsed.text !== "string") {
        throw new AsrProviderError("bad_response", 'ASR JSON response must be an object with a string "text" field');
      }
      const data = parsed;
      const event = {
        text: data.text.trim(),
        isFinal: true,
        durationMs
      };
      if (typeof data.language === "string" && data.language.trim().length > 0) {
        event.language = data.language.trim();
      }
      return event;
    } catch (rawErr) {
      if (abortedByTransport || callerAborted || options?.signal?.aborted) {
        throw new AsrProviderError("aborted", "ASR transcription was aborted");
      }
      if (timedOut) {
        throw new AsrProviderError("timeout", `ASR request timed out after ${this.timeoutMs} ms`);
      }
      if (rawErr instanceof AsrProviderError) {
        throw rawErr;
      }
      throw new AsrProviderError("network", rawErr instanceof Error ? rawErr.message : String(rawErr));
    } finally {
      cancelTimeout(timer);
      options?.signal?.removeEventListener("abort", onCallerAbort);
      this.inflight.delete(handle);
    }
  }
  abort() {
    this.chunks = [];
    this.bufferedSamples = 0;
    this.sessionLanguage = void 0;
    for (const handle of this.inflight) {
      handle.markAborted();
      handle.ac.abort(new Error("ASR aborted"));
    }
    this.inflight.clear();
  }
  async close() {
    this.closed = true;
    this.abort();
  }
};

// node_modules/.pnpm/@voice-mode+core@file+vendor+voice-mode-core-0.1.0.tgz/node_modules/@voice-mode/core/dist/daemon-client.js
var DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:18790";
var DEFAULT_DAEMON_PROBE_TIMEOUT_MS = 800;
var DEFAULT_DAEMON_TIMEOUT_MS = 8e3;
var DEFAULT_DAEMON_HEALTH_TTL_MS = 15e3;
var DEFAULT_DAEMON_COOLDOWN_MS = 5e3;
var DEFAULT_KOKORO_MODEL = "kokoro-v1.1-zh";
var DEFAULT_KOKORO_VOICE = "zf_001";
var KOKORO_MAX_SID = 102;
var EXPECTED_DAEMON_SERVICE = "voice-daemon";
var MAX_HEALTH_BYTES = 64 * 1024;
var MAX_ERROR_MESSAGE_CHARS3 = 240;
var DEFAULT_SAMPLE_RATE2 = 16e3;
var UTF8_DECODER4 = new TextDecoder("utf-8");
var DaemonClientError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(redactSecrets(message));
    this.name = "DaemonClientError";
    this.code = code;
    if (status !== void 0) {
      this.status = status;
    }
  }
};
var KOKORO_DEFAULT_SPEAKERS = [
  { id: "zf_001", sid: 3, label: "Mandarin female (zf_001)", lang: "zh", gender: "F" },
  { id: "zf_xiaobei", sid: 48, label: "Mandarin female (zf_xiaobei / zf_084)", lang: "zh", gender: "F" },
  { id: "zm_010", sid: 59, label: "Mandarin male (zm_010)", lang: "zh", gender: "M" },
  { id: "zm_013", sid: 62, label: "Mandarin deep male (zm_013)", lang: "zh", gender: "M" },
  { id: "af_maple", sid: 0, label: "English US female (af_maple)", lang: "en-us", gender: "F" },
  { id: "af_sol", sid: 1, label: "English US female (af_sol)", lang: "en-us", gender: "F" },
  { id: "bf_vale", sid: 2, label: "English UK female (bf_vale)", lang: "en-gb", gender: "F" }
];
function resolveDaemonBaseUrl(rawUrl) {
  const candidate = typeof rawUrl === "string" && rawUrl.trim().length > 0 ? rawUrl.trim() : DEFAULT_DAEMON_BASE_URL;
  let parsed;
  try {
    parsed = validateLoopbackUrl(candidate);
  } catch (err) {
    throw new DaemonClientError("bad_url", err instanceof Error ? err.message : String(err));
  }
  let basePath = parsed.pathname.replace(/\/+$/, "");
  while (basePath.endsWith("/v1")) {
    basePath = basePath.slice(0, -3).replace(/\/+$/, "");
  }
  return `${parsed.origin}${basePath}`;
}
function normalizeKokoroVoice(voice) {
  if (typeof voice !== "string")
    return DEFAULT_KOKORO_VOICE;
  const trimmed = voice.trim();
  if (!trimmed)
    return DEFAULT_KOKORO_VOICE;
  if (/^-?\d+$/.test(trimmed)) {
    const sid = Number.parseInt(trimmed, 10);
    return Number.isInteger(sid) && sid >= 0 && sid <= KOKORO_MAX_SID ? String(sid) : DEFAULT_KOKORO_VOICE;
  }
  return trimmed;
}
function shouldFallback(err) {
  if (err.code === "network" || err.code === "timeout" || err.code === "bad_audio_payload" || err.code === "bad_response") {
    return true;
  }
  if (err.code === "http_error") {
    return err.status === 401 || err.status === 403 || err.status === 404 || err.status === 405 || err.status !== void 0 && err.status >= 500;
  }
  return false;
}
var DaemonClient = class {
  asr;
  tts;
  baseUrl;
  options;
  probeTimeoutMs;
  timeoutMs;
  healthTtlMs;
  cooldownMs;
  fetchImpl;
  now;
  inflight = /* @__PURE__ */ new Set();
  voiceOverride;
  defaultRate;
  lastError = null;
  healthyUntil = 0;
  unhealthyUntil = 0;
  lastUnhealthyError = null;
  closed = false;
  chunks = [];
  bufferedSamples = 0;
  sessionMaxSamples = Math.floor(DEFAULT_ENDPOINT_POLICY.maxSpeechSec * DEFAULT_SAMPLE_RATE2);
  sessionLanguage;
  constructor(options = {}) {
    this.baseUrl = resolveDaemonBaseUrl(options.baseUrl);
    this.options = options;
    this.probeTimeoutMs = typeof options.probeTimeoutMs === "number" && Number.isFinite(options.probeTimeoutMs) && options.probeTimeoutMs > 0 ? options.probeTimeoutMs : DEFAULT_DAEMON_PROBE_TIMEOUT_MS;
    this.timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_DAEMON_TIMEOUT_MS;
    this.healthTtlMs = typeof options.healthTtlMs === "number" && Number.isFinite(options.healthTtlMs) && options.healthTtlMs >= 0 ? options.healthTtlMs : DEFAULT_DAEMON_HEALTH_TTL_MS;
    this.cooldownMs = typeof options.cooldownMs === "number" && Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0 ? options.cooldownMs : DEFAULT_DAEMON_COOLDOWN_MS;
    this.fetchImpl = resolveFetchImpl(options.fetchImpl);
    this.now = options.now ?? Date.now;
    if (options.voice !== void 0) {
      this.voiceOverride = options.voice.trim();
    }
    if (typeof options.rate === "number" && Number.isFinite(options.rate) && options.rate > 0) {
      this.defaultRate = options.rate;
    }
    this.asr = {
      kind: "daemon",
      start: (opts) => this.startAsr(opts),
      pushAudio: (pcm16k) => this.pushAudio(pcm16k),
      finalize: (sig) => this.finalizeAsr(sig),
      transcribe: (pcm16k, opts) => this.transcribe(pcm16k, opts),
      abort: () => this.abortAsr(),
      close: () => this.close()
    };
    this.tts = {
      kind: "kokoro-daemon",
      mime: "audio/wav",
      updateVoice: (voice, rate) => this.updateVoice(voice, rate),
      prepare: () => this.prepareTts(),
      status: () => this.ttsStatus(),
      interrupt: () => this.interruptTts(),
      synthesize: (text, opts) => this.synthesize(text, opts),
      close: () => this.close()
    };
  }
  asAsrTransport() {
    return this.asr;
  }
  asTtsEngine() {
    return this.tts;
  }
  resetHealthCache() {
    this.healthyUntil = 0;
    this.unhealthyUntil = 0;
    this.lastUnhealthyError = null;
  }
  async probeHealth(signal) {
    if (this.closed) {
      return { ok: false, version: "", capabilities: [], voices: [], error: "Daemon client is closed" };
    }
    if (signal?.aborted) {
      return { ok: false, version: "", capabilities: [], voices: [], error: "Health probe aborted" };
    }
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort(signal?.reason ?? new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = scheduleTimeout(() => {
      timedOut = true;
      ac.abort(new Error("Daemon health probe timed out"));
    }, this.probeTimeoutMs);
    try {
      const token = await resolveSecretValue(this.options.token);
      const headers = { Accept: "application/json" };
      if (token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await raceAbort(this.fetchImpl(`${this.baseUrl}/v1/health`, {
        method: "GET",
        headers,
        signal: ac.signal,
        redirect: "error"
      }), ac.signal);
      if (res.status !== 200) {
        const msg = await readRedactedHttpErrorMessage(res, MAX_ASR_ERROR_BYTES, MAX_ERROR_MESSAGE_CHARS3, ac.signal);
        this.markUnhealthy(new DaemonClientError("http_error", msg, res.status));
        return {
          ok: false,
          version: "",
          capabilities: [],
          voices: [],
          status: res.status,
          error: msg
        };
      }
      const body = await readBoundedStreamBytes(res, MAX_HEALTH_BYTES, ac.signal, () => new DaemonClientError("too_large", `Daemon health exceeds ${MAX_HEALTH_BYTES} bytes`));
      const parsed = JSON.parse(UTF8_DECODER4.decode(body));
      if (typeof parsed !== "object" || parsed === null) {
        const err = new DaemonClientError("bad_response", "Daemon health endpoint returned invalid JSON object");
        this.markUnhealthy(err);
        return { ok: false, version: "", capabilities: [], voices: [], error: err.message };
      }
      const obj = parsed;
      if (obj.ok !== true || obj.service !== EXPECTED_DAEMON_SERVICE) {
        const err = new DaemonClientError("bad_response", 'Loopback endpoint did not identify as service="voice-daemon" with ok=true');
        this.markUnhealthy(err);
        return {
          ok: false,
          version: "",
          capabilities: [],
          voices: [],
          status: res.status,
          error: err.message
        };
      }
      const capabilities = Array.isArray(obj.capabilities) ? obj.capabilities.filter((c) => typeof c === "string") : [];
      const voices = Array.isArray(obj.voices) ? obj.voices.filter((v) => typeof v === "string") : [];
      this.markHealthy();
      return {
        ok: true,
        version: typeof obj.version === "string" ? obj.version : "",
        capabilities,
        voices,
        status: res.status
      };
    } catch (err) {
      const code = timedOut ? "timeout" : "network";
      const reason = timedOut ? `Daemon health probe timed out after ${this.probeTimeoutMs} ms` : redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_CHARS3);
      this.markUnhealthy(new DaemonClientError(code, reason));
      return {
        ok: false,
        version: "",
        capabilities: [],
        voices: [],
        error: reason
      };
    } finally {
      cancelTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  markHealthy() {
    this.healthyUntil = this.now() + this.healthTtlMs;
    this.unhealthyUntil = 0;
    this.lastUnhealthyError = null;
  }
  markUnhealthy(err) {
    this.healthyUntil = 0;
    this.unhealthyUntil = this.cooldownMs > 0 ? this.now() + this.cooldownMs : 0;
    this.lastUnhealthyError = err;
    this.lastError = err;
  }
  async ensureDaemonHealthy(signal) {
    const now = this.now();
    if (this.cooldownMs > 0 && now < this.unhealthyUntil && this.lastUnhealthyError) {
      throw this.lastUnhealthyError;
    }
    if (now < this.healthyUntil) {
      return;
    }
    const health = await this.probeHealth(signal);
    if (signal?.aborted) {
      throw new DaemonClientError("aborted", "Daemon request was aborted");
    }
    if (!health.ok) {
      throw this.lastUnhealthyError ?? new DaemonClientError(health.status !== void 0 && health.status !== 200 ? "http_error" : "network", health.error ?? "Local voice daemon is unavailable", health.status);
    }
  }
  // ── TTS methods (`tts.kind = 'kokoro-daemon'`) ─────────────────────────────
  updateVoice(voice, rate) {
    this.voiceOverride = voice.trim();
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate;
    }
    this.options.fallbackTts?.updateVoice?.(voice, rate);
  }
  async prepareTts() {
    const health = await this.probeHealth();
    if (!health.ok && !this.options.fallbackTts) {
      throw new DaemonClientError(health.status !== void 0 && health.status !== 200 ? "http_error" : "network", health.error ?? "Local voice daemon is unavailable", health.status);
    }
  }
  ttsStatus() {
    const out = {
      engine: "kokoro-daemon",
      ready: !this.closed,
      loading: this.inflight.size > 0,
      keyRequired: false
    };
    if (this.lastError) {
      out.error = this.lastError.message;
      out.errorCode = this.lastError.code;
    }
    return out;
  }
  interruptTts() {
    for (const req of Array.from(this.inflight)) {
      if (req.surface === "tts") {
        req.markAborted();
        req.ac.abort(new Error("TTS interrupted"));
        this.inflight.delete(req);
      }
    }
    this.options.fallbackTts?.interrupt?.();
  }
  async synthesize(text, options) {
    if (this.closed) {
      throw new DaemonClientError("aborted", "Daemon TTS client is closed");
    }
    if (options?.signal?.aborted) {
      throw new DaemonClientError("aborted", "Daemon TTS synthesis was aborted");
    }
    if (stripEmotionTags(text).trim().length === 0) {
      return { audio: new Uint8Array(0), mime: "audio/wav" };
    }
    try {
      await this.ensureDaemonHealthy(options?.signal);
      const result = await this.synthesizePrimary(text, options);
      this.markHealthy();
      this.lastError = null;
      return result;
    } catch (rawErr) {
      const err = rawErr instanceof DaemonClientError ? rawErr : new DaemonClientError("network", rawErr instanceof Error ? rawErr.message : String(rawErr));
      if (err.code === "aborted" || err.code === "bad_url") {
        throw err;
      }
      this.markUnhealthy(err);
      if (this.options.fallbackTts && shouldFallback(err)) {
        this.options.onFallback?.("tts", err.message);
        const fbOpts = {};
        if (options?.voice !== void 0)
          fbOpts.voice = options.voice;
        const rate = options?.rate ?? this.defaultRate;
        if (rate !== void 0)
          fbOpts.rate = rate;
        if (options?.signal !== void 0)
          fbOpts.signal = options.signal;
        return this.options.fallbackTts.synthesize(text, fbOpts);
      }
      throw err;
    }
  }
  async synthesizePrimary(rawText, options) {
    const ac = new AbortController();
    let timedOut = false;
    let localAborted = false;
    let callerAborted = false;
    const handle = {
      ac,
      surface: "tts",
      markAborted: () => {
        localAborted = true;
      }
    };
    this.inflight.add(handle);
    const onCallerAbort = () => {
      callerAborted = true;
      ac.abort(options?.signal?.reason ?? new Error("aborted"));
    };
    options?.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = scheduleTimeout(() => {
      timedOut = true;
      ac.abort(new Error("Daemon TTS request timed out"));
    }, this.timeoutMs);
    try {
      const token = await resolveSecretValue(this.options.token);
      if (localAborted || callerAborted || options?.signal?.aborted || this.closed) {
        throw new DaemonClientError("aborted", "Daemon TTS synthesis was aborted");
      }
      const rawVoice = options?.voice !== void 0 ? options.voice : this.voiceOverride !== void 0 ? this.voiceOverride : this.options.voice;
      const voice = normalizeKokoroVoice(rawVoice);
      const effectiveSpeed = typeof options?.rate === "number" && Number.isFinite(options.rate) && options.rate > 0 ? options.rate : this.defaultRate ?? 1;
      const headers = {
        "Content-Type": "application/json"
      };
      if (token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await raceAbort(this.fetchImpl(`${this.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: DEFAULT_KOKORO_MODEL,
          input: rawText,
          voice,
          speed: effectiveSpeed,
          response_format: "wav"
        }),
        signal: ac.signal,
        redirect: "error"
      }), ac.signal);
      if (!res.ok) {
        const msg = await readRedactedHttpErrorMessage(res, MAX_TTS_ERROR_BYTES, MAX_ERROR_MESSAGE_CHARS3, ac.signal);
        throw new DaemonClientError("http_error", msg, res.status);
      }
      const audio = await readBoundedStreamBytes(res, MAX_AUDIO_BYTES, ac.signal, () => new DaemonClientError("too_large", `Daemon TTS audio exceeds ${MAX_AUDIO_BYTES} bytes`));
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError("aborted", "Daemon TTS synthesis was aborted");
      }
      if (audio.byteLength === 0) {
        throw new DaemonClientError("bad_audio_payload", "Daemon returned empty audio payload");
      }
      const sniffed = sniffAudioMime(audio, res.headers.get("content-type") ?? void 0);
      if (!sniffed) {
        throw new DaemonClientError("bad_audio_payload", "Daemon returned unrecognized or non-audio payload");
      }
      return { audio, mime: sniffed };
    } catch (err) {
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError("aborted", "Daemon TTS synthesis was aborted");
      }
      if (timedOut) {
        throw new DaemonClientError("timeout", `Daemon TTS timed out after ${this.timeoutMs} ms`);
      }
      if (err instanceof DaemonClientError) {
        throw err;
      }
      throw new DaemonClientError("network", err instanceof Error ? err.message : String(err));
    } finally {
      cancelTimeout(timer);
      options?.signal?.removeEventListener("abort", onCallerAbort);
      this.inflight.delete(handle);
    }
  }
  // ── ASR methods (`asr.kind = 'daemon'`) ────────────────────────────────────
  async startAsr(options) {
    if (this.closed) {
      throw new DaemonClientError("aborted", "Daemon ASR transport is closed");
    }
    if (options?.signal?.aborted) {
      throw new DaemonClientError("aborted", "Daemon ASR session was aborted");
    }
    const maxSec = options?.policy?.maxSpeechSec;
    const effectiveMaxSec = typeof maxSec === "number" && Number.isFinite(maxSec) && maxSec > 0 ? maxSec : DEFAULT_ENDPOINT_POLICY.maxSpeechSec;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.sessionMaxSamples = Math.max(0, Math.floor(effectiveMaxSec * DEFAULT_SAMPLE_RATE2));
    this.sessionLanguage = options?.language;
  }
  pushAudio(pcm16k) {
    if (this.closed || !(pcm16k instanceof Float32Array) || pcm16k.length === 0)
      return;
    const remaining = this.sessionMaxSamples - this.bufferedSamples;
    if (remaining <= 0)
      return;
    const slice = pcm16k.length <= remaining ? pcm16k.slice() : pcm16k.slice(0, remaining);
    this.chunks.push(slice);
    this.bufferedSamples += slice.length;
  }
  async finalizeAsr(signal) {
    const merged = mergeFloat32Chunks(this.chunks, this.bufferedSamples);
    const lang = this.sessionLanguage;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.sessionLanguage = void 0;
    const transcribeOpts = {
      sampleRate: DEFAULT_SAMPLE_RATE2
    };
    if (lang !== void 0)
      transcribeOpts.language = lang;
    if (signal !== void 0)
      transcribeOpts.signal = signal;
    return this.transcribe(merged, transcribeOpts);
  }
  async transcribe(pcm16k, options) {
    if (this.closed) {
      throw new DaemonClientError("aborted", "Daemon ASR transport is closed");
    }
    if (options?.signal?.aborted) {
      throw new DaemonClientError("aborted", "Daemon ASR transcription was aborted");
    }
    if (!pcm16k || pcm16k.length === 0) {
      return { text: "", isFinal: true, durationMs: 0 };
    }
    try {
      await this.ensureDaemonHealthy(options?.signal);
      const event = await this.transcribePrimary(pcm16k, options);
      this.markHealthy();
      return event;
    } catch (rawErr) {
      const err = rawErr instanceof DaemonClientError ? rawErr : new DaemonClientError("network", rawErr instanceof Error ? rawErr.message : String(rawErr));
      if (err.code === "aborted" || err.code === "bad_url") {
        throw err;
      }
      this.markUnhealthy(err);
      if (this.options.fallbackAsr && shouldFallback(err)) {
        this.options.onFallback?.("asr", err.message);
        return this.transcribeViaFallback(pcm16k, options);
      }
      throw err;
    }
  }
  async transcribeViaFallback(pcm16k, options) {
    const fb = this.options.fallbackAsr;
    if (!fb) {
      throw new DaemonClientError("network", "Daemon ASR fallback is not configured");
    }
    if (typeof fb.transcribe === "function") {
      return fb.transcribe(pcm16k, options);
    }
    if (fb.start && fb.pushAudio && fb.finalize) {
      const startOpts = {};
      if (options?.language !== void 0)
        startOpts.language = options.language;
      if (options?.signal !== void 0)
        startOpts.signal = options.signal;
      await fb.start(startOpts);
      fb.pushAudio(pcm16k);
      return fb.finalize(options?.signal);
    }
    throw new DaemonClientError("bad_response", "Configured fallbackAsr lacks transcribe()");
  }
  async transcribePrimary(pcm16k, options) {
    if (44 + pcm16k.length * 2 > MAX_ASR_AUDIO_BYTES) {
      throw new DaemonClientError("too_large", `Daemon ASR upload exceeds ${MAX_ASR_AUDIO_BYTES} bytes`);
    }
    const ac = new AbortController();
    let timedOut = false;
    let localAborted = false;
    let callerAborted = false;
    const handle = {
      ac,
      surface: "asr",
      markAborted: () => {
        localAborted = true;
      }
    };
    this.inflight.add(handle);
    const onCallerAbort = () => {
      callerAborted = true;
      ac.abort(options?.signal?.reason ?? new Error("aborted"));
    };
    options?.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = scheduleTimeout(() => {
      timedOut = true;
      ac.abort(new Error("Daemon ASR request timed out"));
    }, this.timeoutMs);
    try {
      const token = await resolveSecretValue(this.options.token);
      if (localAborted || callerAborted || options?.signal?.aborted || this.closed) {
        throw new DaemonClientError("aborted", "Daemon ASR transcription was aborted");
      }
      const effectiveRate = typeof options?.sampleRate === "number" && Number.isFinite(options.sampleRate) && options.sampleRate > 0 ? Math.round(options.sampleRate) : DEFAULT_SAMPLE_RATE2;
      const wav = encodeMonoPcm16Wav(pcm16k, effectiveRate);
      const model = this.options.asrModel?.trim() || "sensevoice";
      const rawLang = options?.language !== void 0 ? options.language : this.options.language;
      const normalizedLang = normalizeWhisperLanguage(rawLang);
      const fields = [
        ["model", model],
        ["response_format", "json"]
      ];
      if (normalizedLang !== void 0) {
        fields.push(["language", normalizedLang]);
      }
      const multipart = buildMultipartFormData(fields, {
        fieldName: "file",
        fileName: "speech.wav",
        contentType: "audio/wav",
        bytes: wav
      });
      const headers = {
        "Content-Type": multipart.contentType
      };
      if (token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
      }
      const durationMs = Math.round(pcm16k.length / effectiveRate * 1e3);
      const res = await raceAbort(this.fetchImpl(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers,
        body: multipart.body,
        signal: ac.signal,
        redirect: "error"
      }), ac.signal);
      if (!res.ok) {
        const msg = await readRedactedHttpErrorMessage(res, MAX_ASR_ERROR_BYTES, MAX_ERROR_MESSAGE_CHARS3, ac.signal);
        throw new DaemonClientError("http_error", msg, res.status);
      }
      const body = await readBoundedStreamBytes(res, MAX_ASR_RESPONSE_BYTES, ac.signal, () => new DaemonClientError("too_large", `Daemon ASR exceeds ${MAX_ASR_RESPONSE_BYTES} bytes`));
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError("aborted", "Daemon ASR transcription was aborted");
      }
      const rawText = UTF8_DECODER4.decode(body);
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/plain")) {
        return { text: rawText.trim(), isFinal: true, durationMs };
      }
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new DaemonClientError("bad_response", `Daemon ASR returned non-JSON response: ${redactBodySnippet(rawText, 160)}`);
      }
      if (typeof parsed !== "object" || parsed === null || typeof parsed.text !== "string") {
        throw new DaemonClientError("bad_response", 'Daemon ASR JSON response must contain a string "text" field');
      }
      const data = parsed;
      const event = {
        text: data.text.trim(),
        isFinal: true,
        durationMs
      };
      if (typeof data.language === "string" && data.language.trim().length > 0) {
        event.language = data.language.trim();
      }
      return event;
    } catch (err) {
      if (localAborted || callerAborted || options?.signal?.aborted) {
        throw new DaemonClientError("aborted", "Daemon ASR transcription was aborted");
      }
      if (timedOut) {
        throw new DaemonClientError("timeout", `Daemon ASR timed out after ${this.timeoutMs} ms`);
      }
      if (err instanceof DaemonClientError) {
        throw err;
      }
      throw new DaemonClientError("network", err instanceof Error ? err.message : String(err));
    } finally {
      cancelTimeout(timer);
      options?.signal?.removeEventListener("abort", onCallerAbort);
      this.inflight.delete(handle);
    }
  }
  abortAsr() {
    this.chunks = [];
    this.bufferedSamples = 0;
    this.sessionLanguage = void 0;
    for (const req of Array.from(this.inflight)) {
      if (req.surface === "asr") {
        req.markAborted();
        req.ac.abort(new Error("ASR aborted"));
        this.inflight.delete(req);
      }
    }
    this.options.fallbackAsr?.abort?.();
  }
  async close() {
    this.closed = true;
    this.interruptTts();
    this.abortAsr();
    await Promise.all([
      this.options.fallbackTts ? this.options.fallbackTts.close().catch(() => void 0) : void 0,
      this.options.fallbackAsr ? this.options.fallbackAsr.close().catch(() => void 0) : void 0
    ]);
  }
};

// src/settings.ts
var EXTENSION_KEY = "voice_mode";
var EXTENSION_VERSION = "0.1.0";
var EMOTION_PROMPT_KEY = "sillytavern-voice-mode-emotion";
var DEFAULT_VOICE_ASSIGNMENT = Object.freeze({
  engine: "system",
  voice: ""
});
var DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  emotionPromptEnabled: false,
  narrationSplitEnabled: true,
  bargeInMode: "detect",
  autoSendOnDictation: false,
  useServerPluginProxy: false,
  defaultVoice: { engine: "system", voice: "" },
  narratorVoice: { engine: "system", voice: "" },
  voiceMap: {},
  openaiTtsPresetId: "openai",
  openaiTtsBaseUrl: "https://api.openai.com/v1",
  openaiTtsModel: "gpt-4o-mini-tts",
  mimoBaseUrl: MIMO_DEFAULT_BASE_URL,
  mimoModel: MIMO_DEFAULT_MODEL,
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  asrEngine: "system",
  asrLanguage: "auto",
  semanticEndpoint: false,
  asrBaseUrl: DEFAULT_ASR_OPENAI_BASE_URL,
  asrModel: DEFAULT_ASR_OPENAI_MODEL,
  asrReplacements: []
});
var SECRET_SLOT_KEYS = Object.freeze({
  openaiTts: "api_key_custom_openai_tts",
  mimo: "voice_mode_mimo_api_key",
  asr: "voice_mode_asr_api_key",
  daemon: "voice_mode_daemon_token"
});
var VALID_TTS_ENGINES = /* @__PURE__ */ new Set([
  "system",
  "openai-compat",
  "mimo",
  "kokoro-daemon"
]);
var VALID_ASR_ENGINES = /* @__PURE__ */ new Set(["system", "openai-compat", "daemon"]);
var VALID_BARGE_IN_MODES = /* @__PURE__ */ new Set(["detect", "auto", "manual"]);
function sanitizeCleanString(val, fallback = "") {
  if (typeof val !== "string") return fallback;
  const trimmed = val.trim();
  if (trimmed.length > 0 && redactSecrets(trimmed) !== trimmed) {
    return fallback;
  }
  return trimmed;
}
function normalizeVoiceAssignment(raw, fallbackEngine = "system") {
  if (typeof raw === "string") {
    const voice2 = sanitizeCleanString(raw, "");
    return { engine: fallbackEngine, voice: voice2 };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      engine: fallbackEngine,
      voice: fallbackEngine === "mimo" ? MIMO_DEFAULT_VOICE : ""
    };
  }
  const obj = raw;
  const engine = VALID_TTS_ENGINES.has(obj.engine) ? obj.engine : fallbackEngine;
  const voice = sanitizeCleanString(
    obj.voice,
    engine === "mimo" ? MIMO_DEFAULT_VOICE : ""
  );
  const out = { engine, voice };
  const presetId = sanitizeCleanString(obj.presetId, "");
  if (presetId) out.presetId = presetId;
  if (typeof obj.rate === "number" && Number.isFinite(obj.rate) && obj.rate > 0) {
    out.rate = Math.min(3, Math.max(0.25, obj.rate));
  }
  return out;
}
function ensureExtensionSettings(store) {
  const raw = store[EXTENSION_KEY];
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const defaultVoice = normalizeVoiceAssignment(src.defaultVoice, "system");
  const narratorVoice = normalizeVoiceAssignment(
    src.narratorVoice,
    defaultVoice.engine
  );
  const voiceMap = {};
  if (src.voiceMap && typeof src.voiceMap === "object" && !Array.isArray(src.voiceMap)) {
    for (const [speakerKey, entry] of Object.entries(
      src.voiceMap
    )) {
      const cleanKey = speakerKey.trim();
      if (!cleanKey) continue;
      voiceMap[cleanKey] = normalizeVoiceAssignment(entry, defaultVoice.engine);
    }
  }
  const repValidation = validateReplacements(src.asrReplacements);
  const asrReplacements = repValidation.ok ? repValidation.rules : [];
  const merged = {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SETTINGS.enabled,
    emotionPromptEnabled: typeof src.emotionPromptEnabled === "boolean" ? src.emotionPromptEnabled : DEFAULT_SETTINGS.emotionPromptEnabled,
    narrationSplitEnabled: typeof src.narrationSplitEnabled === "boolean" ? src.narrationSplitEnabled : DEFAULT_SETTINGS.narrationSplitEnabled,
    bargeInMode: VALID_BARGE_IN_MODES.has(src.bargeInMode) ? src.bargeInMode : DEFAULT_SETTINGS.bargeInMode,
    autoSendOnDictation: typeof src.autoSendOnDictation === "boolean" ? src.autoSendOnDictation : DEFAULT_SETTINGS.autoSendOnDictation,
    semanticEndpoint: typeof src.semanticEndpoint === "boolean" ? src.semanticEndpoint : DEFAULT_SETTINGS.semanticEndpoint,
    useServerPluginProxy: typeof src.useServerPluginProxy === "boolean" ? src.useServerPluginProxy : DEFAULT_SETTINGS.useServerPluginProxy,
    defaultVoice,
    narratorVoice,
    voiceMap,
    openaiTtsPresetId: sanitizeCleanString(
      src.openaiTtsPresetId,
      DEFAULT_SETTINGS.openaiTtsPresetId
    ),
    openaiTtsBaseUrl: sanitizeCleanString(
      src.openaiTtsBaseUrl,
      DEFAULT_SETTINGS.openaiTtsBaseUrl
    ),
    openaiTtsModel: sanitizeCleanString(
      src.openaiTtsModel,
      DEFAULT_SETTINGS.openaiTtsModel
    ),
    mimoBaseUrl: sanitizeCleanString(src.mimoBaseUrl, DEFAULT_SETTINGS.mimoBaseUrl),
    mimoModel: sanitizeCleanString(src.mimoModel, DEFAULT_SETTINGS.mimoModel),
    daemonBaseUrl: sanitizeCleanString(
      src.daemonBaseUrl,
      DEFAULT_SETTINGS.daemonBaseUrl
    ),
    asrEngine: VALID_ASR_ENGINES.has(src.asrEngine) ? src.asrEngine : DEFAULT_SETTINGS.asrEngine,
    asrLanguage: sanitizeCleanString(src.asrLanguage, DEFAULT_SETTINGS.asrLanguage),
    asrBaseUrl: sanitizeCleanString(src.asrBaseUrl, DEFAULT_SETTINGS.asrBaseUrl),
    asrModel: sanitizeCleanString(src.asrModel, DEFAULT_SETTINGS.asrModel),
    asrReplacements
  };
  store[EXTENSION_KEY] = merged;
  return merged;
}
var SillyTavernSecretBroker = class {
  ephemeral = /* @__PURE__ */ new Map();
  host;
  canViewCached = void 0;
  constructor(host) {
    this.host = host;
  }
  async setSecret(slot, value) {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.deleteSecret(slot);
      return;
    }
    const id = await this.host.writeSecret(
      SECRET_SLOT_KEYS[slot],
      trimmed,
      `Voice Mode (${slot})`
    );
    if (id === null) throw new Error("SillyTavern did not save the secret.");
    this.ephemeral.set(slot, trimmed);
    this.canViewCached = void 0;
  }
  async getSecret(slot) {
    const mem = this.ephemeral.get(slot);
    if (mem) return mem;
    const secretKey = SECRET_SLOT_KEYS[slot];
    if (this.host.hasRemoteSecret && !this.host.hasRemoteSecret(secretKey)) {
      return null;
    }
    if (this.host.canViewSecrets) {
      if (this.canViewCached === void 0) {
        const view = await this.host.canViewSecrets();
        if (view === true || view === false) {
          this.canViewCached = view;
        }
      }
      if (this.canViewCached === false) {
        return null;
      }
    }
    const remote = await this.host.findSecret(secretKey);
    if (typeof remote === "string" && remote.trim()) {
      const clean = remote.trim();
      this.ephemeral.set(slot, clean);
      return clean;
    }
    return null;
  }
  async deleteSecret(slot) {
    await this.host.deleteSecret(SECRET_SLOT_KEYS[slot]);
    this.ephemeral.delete(slot);
  }
  knownSecretsSnapshot() {
    return Array.from(this.ephemeral.values());
  }
};
function inspectSecureOrigin(win) {
  const host = win?.location?.host ?? "unknown-host";
  const protocol = win?.location?.protocol ?? "http:";
  const originLabel = `${protocol}//${host}`;
  if (Boolean(win && win.isSecureContext === true)) {
    return {
      secure: true,
      originLabel,
      remediation: ""
    };
  }
  return {
    secure: false,
    originLabel,
    remediation: `Microphone access is blocked on non-secure origin ${originLabel}. Open SillyTavern via http://127.0.0.1 or http://localhost, forward the port over SSH (ssh -L 8000:127.0.0.1:8000), or enable HTTPS (ssl.enabled: true in config.yaml / reverse proxy / Tailscale HTTPS).`
  };
}
function formatSafeError(err, knownSecrets = []) {
  const raw = err instanceof Error ? err.message : String(err);
  let safe = redactSecrets(raw);
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4 && safe.includes(secret)) {
      safe = safe.split(secret).join("[REDACTED]");
    }
  }
  return safe.slice(0, 280);
}

// src/stream-router.ts
function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  return i;
}
function cleanOuterQuotes(text) {
  return text.replace(/^["“”「」『』\s]+|["“”「」『』\s]+$/g, "").trim();
}
function splitTerminalWhisperBoundaries(raw) {
  const out = [];
  const re = /([.!?。！？]["'”’)]?\s*<\s*\/whisper\s*>)\s+/gi;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    const idx = m.index ?? 0;
    const endOfClose = idx + (m[1]?.length ?? 0);
    const head = raw.slice(last, endOfClose).trim();
    if (head) out.push(head);
    last = idx + m[0].length;
  }
  const tail = raw.slice(last).trim();
  if (tail) out.push(tail);
  return out;
}
var StreamingUtteranceRouter = class {
  narrationSplitEnabled;
  segmenterOptions;
  resolveActiveSpeaker;
  onUtterance;
  segmenter;
  armed = false;
  ignoredTurn = false;
  streamSawTokens = false;
  handledLastGenerationByStream = false;
  // Set when a generation is interrupted: the host may still render the truncated
  // message, and re-ingesting it would replay cancelled text. Deliberately not
  // cleared by reset(); cleared by the next onGenerationStarted/onChatChanged.
  suppressNextRendered = false;
  prevCumulativeText = "";
  activeSpeaker = "";
  activeAvatar = void 0;
  inNarration = false;
  pendingStar = false;
  inOpenWhisper = false;
  constructor(options = {}) {
    this.narrationSplitEnabled = options.narrationSplitEnabled ?? true;
    this.segmenterOptions = options.segmenterOptions;
    this.resolveActiveSpeaker = options.resolveActiveSpeaker;
    this.onUtterance = options.onUtterance;
    this.segmenter = new SentenceSegmenter(this.segmenterOptions);
  }
  setNarrationSplitEnabled(enabled) {
    this.narrationSplitEnabled = enabled;
  }
  onGenerationStarted(input = {}) {
    this.suppressNextRendered = false;
    const type = input.type ?? "normal";
    if (input.dryRun === true || type === "quiet" || type === "impersonate") {
      this.reset();
      this.ignoredTurn = true;
      return;
    }
    this.reset();
    const fallback = this.resolveActiveSpeaker?.();
    this.activeSpeaker = input.speaker ?? fallback?.speaker ?? "";
    this.activeAvatar = input.avatar ?? fallback?.avatar;
    this.armed = true;
  }
  onStreamToken(cumulativeText) {
    if (this.ignoredTurn || typeof cumulativeText !== "string" || !cumulativeText) {
      return [];
    }
    if (!this.armed) {
      const fallback = this.resolveActiveSpeaker?.();
      this.activeSpeaker = fallback?.speaker ?? "";
      this.activeAvatar = fallback?.avatar;
      this.armed = true;
    }
    this.streamSawTokens = true;
    let delta;
    if (cumulativeText.startsWith(this.prevCumulativeText)) {
      delta = cumulativeText.slice(this.prevCumulativeText.length);
    } else {
      const prefix = commonPrefixLength(this.prevCumulativeText, cumulativeText);
      delta = cumulativeText.slice(prefix);
    }
    this.prevCumulativeText = cumulativeText;
    if (!delta) return [];
    return this.ingestDelta(delta, this.activeSpeaker, this.activeAvatar);
  }
  onGenerationEnded() {
    if (this.ignoredTurn) {
      this.ignoredTurn = false;
      this.armed = false;
      return [];
    }
    if (!this.armed || !this.streamSawTokens) {
      this.armed = false;
      return [];
    }
    const tail = this.flushActive(this.activeSpeaker, this.activeAvatar);
    this.armed = false;
    this.handledLastGenerationByStream = true;
    return tail;
  }
  onGenerationStopped() {
    this.reset();
    this.suppressNextRendered = true;
  }
  onChatChanged() {
    this.reset();
    this.suppressNextRendered = false;
  }
  onCharacterMessageRendered(input) {
    if (this.suppressNextRendered) {
      this.suppressNextRendered = false;
      return [];
    }
    if (input.type === "impersonate" || input.type === "quiet") {
      return [];
    }
    const msg = input.message;
    if (!msg || msg.is_user || msg.is_system) {
      return [];
    }
    if (this.handledLastGenerationByStream) {
      this.handledLastGenerationByStream = false;
      return [];
    }
    if (this.armed && this.streamSawTokens) {
      const tail = this.flushActive(
        msg.name ?? this.activeSpeaker,
        msg.original_avatar ?? this.activeAvatar
      );
      this.armed = false;
      this.handledLastGenerationByStream = true;
      return tail;
    }
    const displayText = typeof msg.extra?.display_text === "string" && msg.extra.display_text.trim() ? msg.extra.display_text : msg.mes ?? "";
    if (!displayText.trim()) return [];
    this.reset();
    const speaker = msg.name ?? this.resolveActiveSpeaker?.().speaker ?? "";
    const avatar = msg.original_avatar ?? this.resolveActiveSpeaker?.().avatar;
    const out = [
      ...this.ingestDelta(displayText, speaker, avatar),
      ...this.flushActive(speaker, avatar)
    ];
    this.reset();
    return out;
  }
  reset() {
    this.armed = false;
    this.ignoredTurn = false;
    this.streamSawTokens = false;
    this.handledLastGenerationByStream = false;
    this.prevCumulativeText = "";
    this.activeSpeaker = "";
    this.activeAvatar = void 0;
    this.inNarration = false;
    this.pendingStar = false;
    this.inOpenWhisper = false;
    this.segmenter.flush();
  }
  balanceSentenceWhisper(raw) {
    const seeded = this.inOpenWhisper ? `<whisper>${raw}` : raw;
    let depth = 0;
    let rebuilt = "";
    let lastIdx = 0;
    const tagRe = /<\s*(\/?)\s*whisper\s*>/gi;
    for (const match of seeded.matchAll(tagRe)) {
      const idx = match.index ?? 0;
      rebuilt += seeded.slice(lastIdx, idx);
      lastIdx = idx + match[0].length;
      const isClosing = match[1] === "/";
      if (!isClosing) {
        if (depth === 0) rebuilt += "<whisper>";
        depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0) rebuilt += "</whisper>";
      }
    }
    rebuilt += seeded.slice(lastIdx);
    if (depth > 0) {
      rebuilt += "</whisper>";
      this.inOpenWhisper = true;
    } else {
      this.inOpenWhisper = false;
    }
    const collapsed = rebuilt.replace(/<\s*whisper\s*>\s*<\s*\/whisper\s*>/gi, "").trim();
    const textWithoutWhisper = collapsed.replace(/<\s*\/?\s*whisper\s*>/gi, "").trim();
    return textWithoutWhisper ? collapsed : "";
  }
  currentRole() {
    return this.narrationSplitEnabled && this.inNarration ? "narrator" : "character";
  }
  emitSentences(sentences, role, speaker, avatar, out) {
    for (const rawSentence of sentences) {
      for (const raw of splitTerminalWhisperBoundaries(rawSentence)) {
        const preCleaned = role === "character" ? cleanOuterQuotes(raw) : raw.trim();
        const cleaned = this.balanceSentenceWhisper(preCleaned);
        if (!cleaned) continue;
        const utterance = {
          role,
          speaker,
          ...avatar ? { avatar } : {},
          text: cleaned
        };
        out.push(utterance);
        this.onUtterance?.(utterance);
      }
    }
  }
  ingestDelta(delta, speaker, avatar) {
    const out = [];
    if (!this.narrationSplitEnabled) {
      this.emitSentences(this.segmenter.feed(delta), "character", speaker, avatar, out);
      return out;
    }
    const work = this.pendingStar ? `*${delta}` : delta;
    this.pendingStar = false;
    let buf = "";
    let i = 0;
    while (i < work.length) {
      if (work[i] === "*") {
        if (i === work.length - 1) {
          if (buf) {
            this.emitSentences(
              this.segmenter.feed(buf),
              this.currentRole(),
              speaker,
              avatar,
              out
            );
            buf = "";
          }
          this.pendingStar = true;
          i++;
          continue;
        }
        if (work[i + 1] === "*") {
          let runEnd = i + 2;
          while (runEnd < work.length && work[runEnd] === "*") {
            runEnd++;
          }
          buf += work.slice(i, runEnd);
          i = runEnd;
          continue;
        }
        const roleBefore = this.currentRole();
        if (buf) {
          this.emitSentences(this.segmenter.feed(buf), roleBefore, speaker, avatar, out);
          buf = "";
        }
        this.emitSentences(this.segmenter.flush(), roleBefore, speaker, avatar, out);
        this.inOpenWhisper = false;
        this.inNarration = !this.inNarration;
        i++;
        continue;
      }
      buf += work[i];
      i++;
    }
    if (buf) {
      this.emitSentences(
        this.segmenter.feed(buf),
        this.currentRole(),
        speaker,
        avatar,
        out
      );
    }
    return out;
  }
  flushActive(speaker, avatar) {
    const out = [];
    const role = this.currentRole();
    if (this.pendingStar) {
      this.pendingStar = false;
      this.emitSentences(this.segmenter.flush(), role, speaker, avatar, out);
      this.inNarration = false;
      return out;
    }
    this.emitSentences(this.segmenter.flush(), role, speaker, avatar, out);
    this.inNarration = false;
    this.inOpenWhisper = false;
    return out;
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/resample.js
var TARGET_SAMPLE_RATE = 16e3;

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/audio-worklet-source.js
var VOICE_CAPTURE_PROCESSOR_NAME = "voice-capture";
var VOICE_CAPTURE_WORKLET_SOURCE = `
const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_CHUNK_SAMPLES = 1024;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = typeof opts.targetSampleRate === 'number' && opts.targetSampleRate > 0
      ? opts.targetSampleRate
      : DEFAULT_TARGET_RATE;
    this.chunkSamples = typeof opts.chunkSamples === 'number' && opts.chunkSamples > 0
      ? Math.floor(opts.chunkSamples)
      : DEFAULT_CHUNK_SAMPLES;
    this.ratio = sampleRate / this.targetRate;
    this.acc = new Float32Array(0);
    this.accLen = 0;
    this.phase = 0;
    this.outBuf = new Float32Array(this.chunkSamples);
    this.outLen = 0;
    this.stopped = false;
    if (this.port) {
      this.port.onmessage = (event) => {
        const data = event && event.data;
        if (data && data.type === 'stop') {
          this.stopped = true;
        }
      };
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.push(ch);
    this.drain();
    return true;
  }

  push(ch) {
    if (this.accLen + ch.length > this.acc.length) {
      let cap = this.acc.length > 0 ? this.acc.length : Math.max(this.chunkSamples * 4, 2048);
      while (cap < this.accLen + ch.length) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.acc.subarray(0, this.accLen));
      this.acc = next;
    }
    this.acc.set(ch, this.accLen);
    this.accLen += ch.length;
  }

  emitChunk(src) {
    // Always copy into an owned buffer before transferring so internal buffers are never detached.
    const chunk = new Float32Array(this.chunkSamples);
    chunk.set(src);
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  drain() {
    if (sampleRate === this.targetRate) {
      while (this.accLen >= this.chunkSamples) {
        this.emitChunk(this.acc.subarray(0, this.chunkSamples));
        this.acc.copyWithin(0, this.chunkSamples, this.accLen);
        this.accLen -= this.chunkSamples;
      }
      return;
    }

    // Continuous fractional-phase linear interpolation with residual sample retention.
    while (Math.floor(this.phase) + 1 < this.accLen) {
      const i0 = Math.floor(this.phase);
      const frac = this.phase - i0;
      this.outBuf[this.outLen++] = this.acc[i0] + (this.acc[i0 + 1] - this.acc[i0]) * frac;
      this.phase += this.ratio;
      if (this.outLen === this.chunkSamples) {
        this.emitChunk(this.outBuf);
        this.outLen = 0;
      }
    }

    const consumed = Math.min(Math.floor(this.phase), this.accLen);
    if (consumed > 0) {
      const keep = this.accLen - consumed;
      if (keep > 0) this.acc.copyWithin(0, consumed, this.accLen);
      this.accLen = keep;
      this.phase -= consumed;
    }
  }
}

registerProcessor('${VOICE_CAPTURE_PROCESSOR_NAME}', VoiceCaptureProcessor);
`.trim();
function createWorkletModuleUrl(staticUrl, options = {}) {
  const trimmed = typeof staticUrl === "string" ? staticUrl.trim() : "";
  if (trimmed.length > 0) {
    return {
      url: trimmed,
      isBlob: false,
      revoke() {
      }
    };
  }
  const source = options.source ?? VOICE_CAPTURE_WORKLET_SOURCE;
  const createUrl = options.createObjectURL ?? ((b) => URL.createObjectURL(b));
  const revokeUrl = options.revokeObjectURL ?? ((u) => URL.revokeObjectURL(u));
  const blob = new Blob([source], { type: "application/javascript;charset=utf-8" });
  const url = createUrl(blob);
  let revoked = false;
  return {
    url,
    isBlob: true,
    revoke() {
      if (revoked)
        return;
      revoked = true;
      revokeUrl(url);
    }
  };
}

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/aec-probe.js
function probeTrackAec(track, supportedConstraints) {
  const supportedConstraint = supportedConstraints?.echoCancellation === true;
  const settings = track?.getSettings ? track.getSettings() : void 0;
  const applied = typeof settings?.echoCancellation === "boolean" ? settings.echoCancellation : null;
  return {
    supportedConstraint,
    appliedEchoCancellation: applied,
    nativeAecActive: applied === true,
    sampleRate: settings?.sampleRate,
    channelCount: settings?.channelCount
  };
}
function resolveBargeInPolicy(input) {
  const mode = input.requestedMode ?? "detect";
  if (mode === "manual") {
    return {
      policy: "manual",
      reason: "user-selected-manual",
      allowHandsFreeBargeIn: false
    };
  }
  if (input.usesSystemTts === true) {
    return {
      policy: "manual",
      reason: "system-tts-bypasses-aec",
      allowHandsFreeBargeIn: false
    };
  }
  if (input.isMobile) {
    return {
      policy: "manual",
      reason: "mobile-aec-unreliable",
      allowHandsFreeBargeIn: false
    };
  }
  if (mode === "auto") {
    return {
      policy: "auto",
      reason: "ok",
      allowHandsFreeBargeIn: true
    };
  }
  if (input.isEdge) {
    return {
      policy: "manual",
      reason: "edge-aec-unreliable",
      allowHandsFreeBargeIn: false
    };
  }
  if (input.isSafari) {
    return {
      policy: "manual",
      reason: "safari-aec-unreliable",
      allowHandsFreeBargeIn: false
    };
  }
  if (input.nativeAecActive !== true) {
    return {
      policy: "manual",
      reason: "native-aec-inactive",
      allowHandsFreeBargeIn: false
    };
  }
  return {
    policy: "auto",
    reason: "ok",
    allowHandsFreeBargeIn: true
  };
}

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/playback-queue.js
function raceWithAbort(promise, signal) {
  if (signal.aborted)
    return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled)
        return;
      settled = true;
      resolve({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve({ aborted: false, value });
    }, (err) => {
      if (settled)
        return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
var PlaybackQueue = class {
  synthesize;
  sink;
  prefetchDepth;
  maxQueueSize;
  overflowPolicy;
  onPlayStart;
  onDrop;
  onStateChange;
  onError;
  currentEpoch = 0;
  currentState = "idle";
  waiting = [];
  prefetched = [];
  playingEntry = null;
  pauseGate = null;
  pumpRunning = false;
  drainWaiters = [];
  constructor(options) {
    this.synthesize = options.synthesize;
    this.sink = options.sink;
    this.prefetchDepth = Math.max(1, Math.floor(options.prefetchDepth ?? 2));
    this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize ?? 200));
    this.overflowPolicy = options.overflowPolicy ?? "drop-newest";
    this.onPlayStart = options.onPlayStart;
    this.onDrop = options.onDrop;
    this.onStateChange = options.onStateChange;
    this.onError = options.onError;
  }
  get state() {
    return this.currentState;
  }
  get epoch() {
    return this.currentEpoch;
  }
  get pendingCount() {
    return this.waiting.length + this.prefetched.length + (this.playingEntry ? 1 : 0);
  }
  /**
   * Enqueue a sentence for bounded-prefetch synthesis and ordered playback.
   * Returns `true` if the sentence was accepted into the queue, `false` if skipped or dropped.
   */
  enqueue(text) {
    if (this.currentState === "disposed")
      return false;
    const trimmed = text.trim();
    if (!trimmed)
      return false;
    if (this.waiting.length >= this.maxQueueSize) {
      if (this.overflowPolicy === "drop-oldest") {
        const dropped = this.waiting.shift();
        if (dropped)
          this.notifyDrop(dropped.text);
      } else {
        this.notifyDrop(trimmed);
        return false;
      }
    }
    this.waiting.push({ text: trimmed, epoch: this.currentEpoch });
    if (this.currentState === "idle") {
      this.setState("playing");
    }
    this.fillPrefetchWindow();
    void this.ensurePump();
    return true;
  }
  /**
   * Suspend active playback and hold inter-sentence advancement until `resume()`,
   * `skipCurrent()`, `cancel()`, or `dispose()` is called.
   */
  pause() {
    if (this.currentState !== "playing")
      return false;
    void this.ensurePauseGate();
    this.setState("paused");
    try {
      this.sink.pause?.();
    } catch {
    }
    return true;
  }
  /**
   * Resume a paused queue back to `'playing'` and release the inter-sentence pause gate.
   */
  resume() {
    if (this.currentState !== "paused")
      return false;
    this.setState("playing");
    try {
      this.sink.resume?.();
    } catch {
    }
    this.releasePauseGate();
    if (this.isEmpty() && !this.pumpRunning) {
      this.setState("idle");
      this.resolveDrainWaiters();
    } else if (!this.isEmpty()) {
      void this.ensurePump();
    }
    return true;
  }
  /**
   * Abort ONLY the currently synthesizing/playing head sentence without clearing
   * prefetched or waiting sentences. If `'paused'`, resumes `'playing'` into the next
   * sentence (or transitions directly to `'idle'` when no items remain).
   */
  skipCurrent() {
    if (this.currentState !== "playing" && this.currentState !== "paused") {
      return false;
    }
    const active = this.playingEntry;
    this.playingEntry = null;
    if (active) {
      active.synthController.abort(new Error("playback skipped"));
      active.playController.abort(new Error("playback skipped"));
    }
    try {
      this.sink.stop?.();
    } catch {
    }
    this.fillPrefetchWindow();
    if (this.isEmpty()) {
      this.setState("idle");
      this.releasePauseGate();
      this.resolveDrainWaiters();
    } else {
      if (this.currentState === "paused") {
        this.setState("playing");
      }
      this.releasePauseGate();
      void this.ensurePump();
    }
    return true;
  }
  /**
   * Immediately interrupt active playback and drop all prefetched/queued sentences.
   * Advances the monotonic epoch so stalled syntheses/sinks from prior epochs neither
   * block nor resurrect into newer playback.
   */
  cancel() {
    if (this.currentState === "disposed")
      return;
    this.abortCurrentEpoch();
    this.setState("idle");
    this.resolveDrainWaiters();
  }
  /** Permanently dispose the queue; subsequent `enqueue` calls are ignored. */
  dispose() {
    if (this.currentState === "disposed")
      return;
    this.abortCurrentEpoch();
    this.setState("disposed");
    this.resolveDrainWaiters();
  }
  /** Resolves once the queue is empty and no synthesis or playback is active (or on cancel/dispose). */
  waitUntilDrained() {
    if (this.isEmpty() && this.currentState !== "paused")
      return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
  isEmpty() {
    return this.waiting.length === 0 && this.prefetched.length === 0 && this.playingEntry === null;
  }
  isDisposed() {
    return this.currentState === "disposed";
  }
  ensurePauseGate() {
    if (!this.pauseGate) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      this.pauseGate = { promise, release };
    }
    return this.pauseGate.promise;
  }
  releasePauseGate() {
    const gate = this.pauseGate;
    this.pauseGate = null;
    gate?.release();
  }
  notifyDrop(droppedText) {
    try {
      this.onDrop?.(droppedText, "overflow");
    } catch {
    }
  }
  setState(next) {
    if (this.currentState === next)
      return;
    this.currentState = next;
    try {
      this.onStateChange?.(next);
    } catch {
    }
  }
  resolveDrainWaiters() {
    if (this.drainWaiters.length === 0)
      return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters)
      resolve();
  }
  abortCurrentEpoch() {
    this.currentEpoch++;
    this.waiting.length = 0;
    const inflight = this.prefetched;
    this.prefetched = [];
    for (const item of inflight) {
      item.controller.abort(new Error("playback cancelled"));
    }
    const active = this.playingEntry;
    this.playingEntry = null;
    if (active) {
      active.synthController.abort(new Error("playback cancelled"));
      active.playController.abort(new Error("playback cancelled"));
    }
    this.releasePauseGate();
    try {
      this.sink.stop?.();
    } catch {
    }
  }
  /**
   * Maintain backpressure: total in-window items (`playing + prefetched`) never exceed `prefetchDepth`.
   */
  fillPrefetchWindow() {
    if (this.currentState === "disposed")
      return;
    const activeSlots = this.prefetched.length + (this.playingEntry ? 1 : 0);
    let available = this.prefetchDepth - activeSlots;
    while (available > 0 && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next.epoch !== this.currentEpoch)
        continue;
      const controller = new AbortController();
      const item = {
        text: next.text,
        epoch: next.epoch,
        controller,
        failed: false,
        promise: Promise.resolve(null)
      };
      item.promise = Promise.resolve().then(() => this.synthesize(next.text, controller.signal)).catch((err) => {
        item.failed = true;
        if (item.epoch === this.currentEpoch && !controller.signal.aborted) {
          try {
            this.onError?.(err, next.text);
          } catch {
          }
        }
        return null;
      });
      this.prefetched.push(item);
      available--;
    }
  }
  async ensurePump() {
    if (this.pumpRunning || this.isDisposed())
      return;
    this.pumpRunning = true;
    try {
      while (!this.isDisposed()) {
        while (this.currentState === "paused" && !this.isDisposed()) {
          await this.ensurePauseGate();
        }
        if (this.isDisposed())
          break;
        this.fillPrefetchWindow();
        const head = this.prefetched.shift();
        if (!head)
          break;
        const playController = new AbortController();
        const playToken = {
          epoch: head.epoch,
          synthController: head.controller,
          playController
        };
        this.playingEntry = playToken;
        const synthOutcome = await raceWithAbort(head.promise, head.controller.signal);
        if (synthOutcome.aborted || playController.signal.aborted || this.isDisposed() || head.epoch !== this.currentEpoch || this.playingEntry !== playToken) {
          if (this.playingEntry === playToken)
            this.playingEntry = null;
          continue;
        }
        while (this.currentState === "paused" && !playController.signal.aborted && !this.isDisposed() && head.epoch === this.currentEpoch && this.playingEntry === playToken) {
          await raceWithAbort(this.ensurePauseGate(), playController.signal);
        }
        if (playController.signal.aborted || this.isDisposed() || head.epoch !== this.currentEpoch || this.playingEntry !== playToken) {
          if (this.playingEntry === playToken)
            this.playingEntry = null;
          continue;
        }
        const payload = synthOutcome.value;
        if (payload && payload.audio.byteLength > 0 && !head.failed) {
          try {
            this.onPlayStart?.(head.text);
          } catch {
          }
          if (playController.signal.aborted || this.isDisposed() || head.epoch !== this.currentEpoch || this.playingEntry !== playToken) {
            if (this.playingEntry === playToken)
              this.playingEntry = null;
            continue;
          }
          while (this.currentState === "paused" && !playController.signal.aborted && !this.isDisposed() && head.epoch === this.currentEpoch && this.playingEntry === playToken) {
            await raceWithAbort(this.ensurePauseGate(), playController.signal);
          }
          if (playController.signal.aborted || this.isDisposed() || head.epoch !== this.currentEpoch || this.playingEntry !== playToken) {
            if (this.playingEntry === playToken)
              this.playingEntry = null;
            continue;
          }
          try {
            const playPromise = Promise.resolve().then(() => this.sink.play(payload, playController.signal));
            playPromise.catch(() => void 0);
            await raceWithAbort(playPromise, playController.signal);
          } catch (err) {
            if (head.epoch === this.currentEpoch && !playController.signal.aborted && !this.isDisposed()) {
              try {
                this.onError?.(err, head.text);
              } catch {
              }
            }
          }
        }
        if (this.playingEntry === playToken) {
          this.playingEntry = null;
        }
        this.fillPrefetchWindow();
      }
    } finally {
      this.pumpRunning = false;
      if (!this.isDisposed()) {
        if (this.currentState === "paused") {
          if (!this.isEmpty()) {
            void this.ensurePump();
          }
        } else if (this.isEmpty()) {
          this.setState("idle");
          this.resolveDrainWaiters();
        } else {
          void this.ensurePump();
        }
      }
    }
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/worker-protocol.js
function collectRequestTransferables(req) {
  const seen = /* @__PURE__ */ new Set();
  const add = (buf) => {
    if (buf instanceof ArrayBuffer)
      seen.add(buf);
  };
  switch (req.type) {
    case "model:load":
      if (Array.isArray(req.files)) {
        for (const file of req.files) {
          if (file)
            add(file.buffer);
        }
      }
      break;
    case "vad:process":
    case "asr:stream-push":
    case "asr:transcribe":
      add(req.pcm);
      break;
    case "asr:stream-finish":
      add(req.fullPcm);
      break;
    default:
      break;
  }
  return Array.from(seen);
}
var REQUEST_TYPES = /* @__PURE__ */ new Set([
  "model:load",
  "vad:process",
  "vad:reset",
  "asr:stream-start",
  "asr:stream-push",
  "asr:stream-finish",
  "asr:transcribe",
  "tts:synthesize",
  "worker:cancel",
  "worker:dispose"
]);
var RESPONSE_TYPES = /* @__PURE__ */ new Set([
  "model:loaded",
  "vad:result",
  "asr:partial",
  "asr:final",
  "tts:result",
  "worker:ack",
  "worker:error"
]);
function isWorkerRequest(msg) {
  if (typeof msg !== "object" || msg === null)
    return false;
  const rec = msg;
  return typeof rec.id === "number" && Number.isInteger(rec.id) && rec.id >= 0 && typeof rec.type === "string" && REQUEST_TYPES.has(rec.type);
}
function isWorkerResponse(msg) {
  if (typeof msg !== "object" || msg === null)
    return false;
  const rec = msg;
  return typeof rec.id === "number" && Number.isInteger(rec.id) && rec.id >= 0 && typeof rec.type === "string" && RESPONSE_TYPES.has(rec.type);
}

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/sherpa-worker-client.js
function scheduleTimer(callback, ms) {
  const fn = typeof setTimeout === "function" ? setTimeout : void 0;
  if (!fn) {
    throw new Error("Timer API is unavailable in this runtime");
  }
  return fn(callback, ms);
}
function cancelTimer(id) {
  const fn = typeof clearTimeout === "function" ? clearTimeout : void 0;
  if (fn && id !== void 0) {
    fn(id);
  }
}
var SherpaWorkerError = class extends Error {
  code;
  retryable;
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "SherpaWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
};
var DEFAULT_REQUEST_TIMEOUT_MS = 45e3;
var DEFAULT_IDLE_UNLOAD_MS = 3e5;
var DISPOSE_GRACE_TIMEOUT_MS = 2e3;
function defaultWorkerFactory(scriptSource) {
  const blob = new Blob([scriptSource], { type: "application/javascript;charset=utf-8" });
  const blobUrl = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => {
    if (revoked)
      return;
    revoked = true;
    URL.revokeObjectURL(blobUrl);
  };
  try {
    const worker = new Worker(blobUrl);
    return { worker, revoke };
  } catch (err) {
    revoke();
    throw err;
  }
}
var SherpaWorkerClient = class {
  createWorkerSource;
  loadModelBinaries;
  workerFactory;
  modelConfigs;
  requestTimeoutMs;
  idleUnloadMs;
  onIdleUnload;
  worker = null;
  revokeWorkerUrl = void 0;
  spawningWorker = null;
  workerGeneration = 0;
  wasmInitialized = false;
  loadedTargets = /* @__PURE__ */ new Set();
  inFlightLoads = /* @__PURE__ */ new Map();
  loadSerializeChain = Promise.resolve();
  nextRequestId = 1;
  pending = /* @__PURE__ */ new Map();
  activeRequests = 0;
  keepAlive = false;
  idleTimer = null;
  disposed = false;
  constructor(options) {
    this.createWorkerSource = options.createWorkerSource;
    this.loadModelBinaries = options.loadModelBinaries;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.modelConfigs = options.modelConfigs ?? {};
    this.requestTimeoutMs = Math.max(100, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
    this.onIdleUnload = options.onIdleUnload;
  }
  /** Lock/unlock idle auto-unload (e.g. while microphone capture is active). */
  setKeepAlive(active) {
    this.keepAlive = active;
    if (active) {
      this.clearIdleTimer();
    } else if (this.activeRequests === 0 && this.worker !== null && !this.disposed) {
      this.scheduleIdleTimer();
    }
  }
  /** Dynamically reconfigure the idle auto-unload delay (`<= 0` disables auto-unload). */
  updateIdleUnloadMs(ms) {
    this.idleUnloadMs = ms;
    this.clearIdleTimer();
    if (!this.disposed && !this.keepAlive && this.activeRequests === 0 && this.worker !== null) {
      this.scheduleIdleTimer();
    }
  }
  /**
   * Update model initialization parameters for a target (`vad`, `asr-offline`, `tts-vits`).
   * If the target is currently loaded with different parameters, marks it stale so the next
   * inference call reloads it cleanly in place (`freeInstance` + fresh config).
   */
  updateModelConfig(target, config) {
    const prevJson = JSON.stringify(this.modelConfigs[target] ?? {});
    const nextConfig = { ...config };
    const nextJson = JSON.stringify(nextConfig);
    this.modelConfigs[target] = nextConfig;
    if (prevJson !== nextJson) {
      this.loadedTargets.delete(target);
    }
  }
  isLoaded(target) {
    return this.loadedTargets.has(target) && this.worker !== null;
  }
  ensureVadLoaded() {
    return this.ensureTargetLoaded("vad");
  }
  ensureAsrLoaded() {
    return this.ensureTargetLoaded("asr-offline");
  }
  ensureTtsLoaded() {
    return this.ensureTargetLoaded("tts-vits");
  }
  async processVad(pcm16k) {
    this.assertNotDisposed();
    await this.ensureVadLoaded();
    const owned = pcm16k.slice();
    const res = await this.sendRequest({
      id: this.allocId(),
      type: "vad:process",
      pcm: owned.buffer,
      sampleRate: TARGET_SAMPLE_RATE
    });
    if (res.type !== "vad:result") {
      throw new Error(`Unexpected worker response for vad:process: ${res.type}`);
    }
    return res;
  }
  async resetVad() {
    this.assertNotDisposed();
    if (!this.isLoaded("vad"))
      return;
    const res = await this.sendRequest({
      id: this.allocId(),
      type: "vad:reset"
    });
    if (res.type !== "worker:ack") {
      throw new Error(`Unexpected worker response for vad:reset: ${res.type}`);
    }
  }
  async transcribe(pcm16k, options) {
    this.assertNotDisposed();
    if (options?.language) {
      const currentAsrCfg = this.modelConfigs["asr-offline"] ?? {};
      if (currentAsrCfg.language !== options.language) {
        this.updateModelConfig("asr-offline", {
          ...currentAsrCfg,
          language: options.language
        });
      }
    }
    await this.ensureAsrLoaded();
    const owned = pcm16k.slice();
    const res = await this.sendRequest({
      id: this.allocId(),
      type: "asr:transcribe",
      pcm: owned.buffer,
      sampleRate: options?.sampleRate ?? TARGET_SAMPLE_RATE,
      language: options?.language
    });
    if (res.type !== "asr:final") {
      throw new Error(`Unexpected worker response for asr:transcribe: ${res.type}`);
    }
    return res;
  }
  async synthesizeTts(text, options) {
    this.assertNotDisposed();
    await this.ensureTtsLoaded();
    const res = await this.sendRequest({
      id: this.allocId(),
      type: "tts:synthesize",
      text,
      speakerId: options?.speakerId,
      speed: options?.speed
    });
    if (res.type !== "tts:result") {
      throw new Error(`Unexpected worker response for tts:synthesize: ${res.type}`);
    }
    return res;
  }
  async unload() {
    this.clearIdleTimer();
    this.workerGeneration++;
    const spawning = this.spawningWorker;
    let workerToClose = this.worker;
    const revokeToCall = this.revokeWorkerUrl;
    this.worker = null;
    this.revokeWorkerUrl = void 0;
    this.spawningWorker = null;
    this.resetWorkerState();
    const unloadReason = new Error("Worker unloaded");
    const pendingEntries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pendingEntries) {
      cancelTimer(entry.timer);
      entry.reject(unloadReason);
    }
    if (!workerToClose && spawning) {
      try {
        workerToClose = await spawning;
      } catch {
      }
    }
    if (workerToClose) {
      workerToClose.onerror = null;
      try {
        await this.sendDetachedDisposeBestEffort(workerToClose);
      } catch {
      }
      workerToClose.onmessage = null;
      try {
        workerToClose.terminate();
      } catch {
      }
    }
    if (revokeToCall) {
      try {
        revokeToCall();
      } catch {
      }
    }
  }
  async dispose() {
    if (this.disposed)
      return;
    this.disposed = true;
    this.keepAlive = false;
    await this.unload();
  }
  assertNotDisposed() {
    if (this.disposed) {
      throw new Error("SherpaWorkerClient is disposed");
    }
  }
  allocId() {
    return this.nextRequestId++;
  }
  beginActivity() {
    this.activeRequests++;
    this.clearIdleTimer();
  }
  endActivity() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0 && !this.keepAlive && !this.disposed && this.worker !== null) {
      this.scheduleIdleTimer();
    }
  }
  clearIdleTimer() {
    if (this.idleTimer !== null) {
      cancelTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }
  scheduleIdleTimer() {
    this.clearIdleTimer();
    if (this.idleUnloadMs <= 0 || this.keepAlive || this.disposed || this.worker === null) {
      return;
    }
    this.idleTimer = scheduleTimer(() => {
      this.idleTimer = null;
      if (this.activeRequests > 0 || this.keepAlive || this.disposed || this.worker === null) {
        return;
      }
      void this.handleIdleTimeout();
    }, this.idleUnloadMs);
  }
  async handleIdleTimeout() {
    if (this.activeRequests > 0 || this.keepAlive || this.disposed || this.worker === null) {
      return;
    }
    await this.unload();
    try {
      this.onIdleUnload?.();
    } catch {
    }
  }
  ensureWorker() {
    if (this.worker)
      return Promise.resolve(this.worker);
    if (this.spawningWorker)
      return this.spawningWorker;
    const gen = ++this.workerGeneration;
    const promise = (async () => {
      const source = await this.createWorkerSource();
      if (this.disposed || gen !== this.workerGeneration) {
        throw new Error("Worker spawn cancelled");
      }
      const { worker, revoke } = this.workerFactory(source);
      worker.onmessage = (ev) => {
        if (gen !== this.workerGeneration)
          return;
        this.handleWorkerMessage(ev.data);
      };
      worker.onerror = (ev) => {
        if (gen !== this.workerGeneration)
          return;
        const reason = ev?.message ? `Sherpa worker crashed: ${ev.message}` : "Sherpa worker crashed";
        this.teardownWorkerSync(new Error(reason));
      };
      this.worker = worker;
      this.revokeWorkerUrl = revoke;
      return worker;
    })();
    this.spawningWorker = promise;
    void promise.then(() => {
      if (this.spawningWorker === promise)
        this.spawningWorker = null;
    }, () => {
      if (this.spawningWorker === promise)
        this.spawningWorker = null;
    });
    return promise;
  }
  ensureTargetLoaded(target) {
    this.assertNotDisposed();
    const conflictingTarget = target === "asr-offline" ? "tts-vits" : target === "tts-vits" ? "asr-offline" : null;
    if (this.isLoaded(target) && (!conflictingTarget || !this.inFlightLoads.has(conflictingTarget))) {
      return Promise.resolve();
    }
    const existing = this.inFlightLoads.get(target);
    if (existing)
      return existing;
    const loadPromise = new Promise((resolve, reject) => {
      this.loadSerializeChain = this.loadSerializeChain.then(async () => {
        this.beginActivity();
        try {
          this.assertNotDisposed();
          if (this.isLoaded(target)) {
            resolve();
            return;
          }
          await this.ensureWorker();
          const gen = this.workerGeneration;
          const includeWasm = !this.wasmInitialized;
          const files = await this.loadModelBinaries(target, includeWasm);
          if (this.disposed || gen !== this.workerGeneration) {
            throw new Error(`Model load (${target}) aborted due to worker reset`);
          }
          const res = await this.sendRequestRaw({
            id: this.allocId(),
            type: "model:load",
            target,
            files,
            config: this.modelConfigs[target]
          }, this.requestTimeoutMs);
          if (res.type !== "model:loaded") {
            throw new Error(`Unexpected worker response for model:load: ${res.type}`);
          }
          if (gen === this.workerGeneration) {
            this.wasmInitialized = true;
            if (target === "asr-offline") {
              this.loadedTargets.delete("tts-vits");
            } else if (target === "tts-vits") {
              this.loadedTargets.delete("asr-offline");
            }
            this.loadedTargets.add(target);
          }
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (this.inFlightLoads.get(target) === loadPromise) {
            this.inFlightLoads.delete(target);
          }
          this.endActivity();
        }
      });
    });
    this.inFlightLoads.set(target, loadPromise);
    return loadPromise;
  }
  async sendRequest(req) {
    this.beginActivity();
    try {
      await this.ensureWorker();
      return await this.sendRequestRaw(req, this.requestTimeoutMs);
    } finally {
      this.endActivity();
    }
  }
  sendRequestRaw(req, timeoutMs) {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error("Sherpa worker is not running"));
    }
    return new Promise((resolve, reject) => {
      const timer = scheduleTimer(() => {
        this.pending.delete(req.id);
        const err = new Error(`Sherpa worker request ${req.type} (#${req.id}) timed out after ${timeoutMs}ms`);
        this.teardownWorkerSync(err);
        reject(err);
      }, timeoutMs);
      this.pending.set(req.id, { resolve, reject, timer });
      try {
        const transfer = collectRequestTransferables(req);
        if (transfer.length > 0) {
          worker.postMessage(req, transfer);
        } else {
          worker.postMessage(req);
        }
      } catch (err) {
        cancelTimer(timer);
        this.pending.delete(req.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  sendDetachedDisposeBestEffort(worker) {
    const req = { id: this.allocId(), type: "worker:dispose" };
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled)
          return;
        settled = true;
        cancelTimer(timer);
        worker.onmessage = null;
        resolve();
      };
      const timer = scheduleTimer(finish, Math.min(this.requestTimeoutMs, DISPOSE_GRACE_TIMEOUT_MS));
      worker.onmessage = (ev) => {
        if (isWorkerResponse(ev?.data) && ev.data.id === req.id) {
          finish();
        }
      };
      try {
        worker.postMessage(req);
      } catch {
        finish();
      }
    });
  }
  handleWorkerMessage(data) {
    if (!isWorkerResponse(data))
      return;
    const entry = this.pending.get(data.id);
    if (!entry)
      return;
    cancelTimer(entry.timer);
    this.pending.delete(data.id);
    if (data.type === "worker:error") {
      entry.reject(new SherpaWorkerError(data.code, data.message, data.retryable));
      return;
    }
    entry.resolve(data);
  }
  resetWorkerState() {
    this.wasmInitialized = false;
    this.loadedTargets.clear();
    this.inFlightLoads.clear();
  }
  teardownWorkerSync(reason) {
    this.workerGeneration++;
    this.clearIdleTimer();
    const pendingEntries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of pendingEntries) {
      cancelTimer(entry.timer);
      entry.reject(reason);
    }
    const worker = this.worker;
    const revoke = this.revokeWorkerUrl;
    this.worker = null;
    this.revokeWorkerUrl = void 0;
    this.spawningWorker = null;
    this.resetWorkerState();
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
      }
    }
    if (revoke) {
      try {
        revoke();
      } catch {
      }
    }
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/dictation-session.js
var DICTATION_PRE_ROLL_MS = 640;
var DICTATION_PRE_ROLL_SAMPLES = DICTATION_PRE_ROLL_MS * TARGET_SAMPLE_RATE / 1e3;
var SILERO_DEFAULT_MIN_SILENCE_SAMPLES = Math.round(0.35 * TARGET_SAMPLE_RATE);
var INTER_UTTERANCE_SILENCE_LEAD_SAMPLES = Math.round(0.16 * TARGET_SAMPLE_RATE);
var PTT_MIN_DURATION_MS = 150;
var PTT_MIN_SAMPLES = Math.round(PTT_MIN_DURATION_MS / 1e3 * TARGET_SAMPLE_RATE);
async function createBrowserMicCapture(options) {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture (navigator.mediaDevices.getUserMedia) is unavailable");
  }
  const audioConstraints = {
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? true
  };
  if (options.deviceId) {
    audioConstraints.deviceId = { exact: options.deviceId };
  }
  const supportedConstraints = typeof navigator.mediaDevices.getSupportedConstraints === "function" ? navigator.mediaDevices.getSupportedConstraints() : void 0;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  const primaryTrack = (typeof stream.getAudioTracks === "function" ? stream.getAudioTracks()[0] : void 0) ?? stream.getTracks()[0] ?? null;
  let workletHandle = null;
  let audioContext = null;
  let sourceNode = null;
  let workletNode = null;
  let sinkGain = null;
  let stopped = false;
  const teardown = async () => {
    if (stopped)
      return;
    stopped = true;
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.port.postMessage({ type: "stop" });
      } catch {
      }
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
      }
    }
    if (workletNode) {
      try {
        workletNode.disconnect();
      } catch {
      }
    }
    if (sinkGain) {
      try {
        sinkGain.disconnect();
      } catch {
      }
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
      }
    }
    if (audioContext) {
      try {
        if (audioContext.state !== "closed") {
          await audioContext.close();
        }
      } catch {
      }
    }
    if (workletHandle) {
      try {
        workletHandle.revoke();
      } catch {
      }
    }
  };
  try {
    workletHandle = createWorkletModuleUrl(options.workletUrl);
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(workletHandle.url);
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    sourceNode = audioContext.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(audioContext, VOICE_CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        targetSampleRate: TARGET_SAMPLE_RATE,
        chunkSamples: options.chunkSamples ?? 1024
      }
    });
    sinkGain = audioContext.createGain();
    sinkGain.gain.value = 0;
    workletNode.port.onmessage = (ev) => {
      if (stopped)
        return;
      const payload = ev.data;
      if (payload instanceof Float32Array && payload.length > 0) {
        options.onChunk(payload);
      } else if (payload instanceof ArrayBuffer && payload.byteLength > 0) {
        options.onChunk(new Float32Array(payload));
      }
    };
    workletNode.onprocessorerror = () => {
      if (stopped)
        return;
      options.onError?.(new Error("AudioWorklet voice capture processor error"));
    };
    sourceNode.connect(workletNode);
    workletNode.connect(sinkGain);
    sinkGain.connect(audioContext.destination);
    return {
      stop: teardown,
      track: primaryTrack,
      supportedConstraints
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/barge-in-monitor.js
var DEFAULT_BARGE_IN_CHUNK_SAMPLES = 1024;
var DEFAULT_BARGE_IN_MIN_RMS = 45e-4;
var DEFAULT_BARGE_IN_CONFIRM_CHUNKS = 2;
function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
function computeChunkRms(samples) {
  if (samples.length === 0)
    return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}
function createBargeInMicCapture(options) {
  return createBrowserMicCapture({
    ...options,
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? false,
    chunkSamples: options.chunkSamples ?? DEFAULT_BARGE_IN_CHUNK_SAMPLES
  });
}
var AecBargeInMonitor = class {
  workerClient;
  captureAudio;
  bargeInMode;
  usesSystemTts;
  isEdge;
  isSafari;
  isMobile;
  workletUrl;
  deviceId;
  chunkSamples;
  minRmsThreshold;
  confirmChunks;
  onBargeIn;
  onDowngrade;
  onError;
  currentState = "idle";
  currentPolicy = null;
  monitorEpoch = 0;
  startedAtMs = 0;
  captureHandle = null;
  inFlightTeardown = null;
  acceptingChunks = false;
  bargeInTriggered = false;
  consecutiveSpeechChunks = 0;
  nonSpeechChunksSinceReset = 0;
  vadQueue = Promise.resolve();
  constructor(options) {
    this.workerClient = options.workerClient;
    this.captureAudio = options.captureAudio ?? createBargeInMicCapture;
    this.bargeInMode = options.bargeInMode ?? "detect";
    this.usesSystemTts = options.usesSystemTts ?? false;
    this.isEdge = options.isEdge ?? false;
    this.isSafari = options.isSafari ?? false;
    this.isMobile = options.isMobile ?? false;
    this.workletUrl = options.workletUrl;
    this.deviceId = options.deviceId;
    this.chunkSamples = Math.max(128, Math.floor(options.chunkSamples ?? DEFAULT_BARGE_IN_CHUNK_SAMPLES));
    this.minRmsThreshold = typeof options.minRmsThreshold === "number" && Number.isFinite(options.minRmsThreshold) ? Math.max(0, options.minRmsThreshold) : DEFAULT_BARGE_IN_MIN_RMS;
    this.confirmChunks = Math.max(1, Math.floor(options.confirmChunks ?? DEFAULT_BARGE_IN_CONFIRM_CHUNKS));
    this.onBargeIn = options.onBargeIn;
    this.onDowngrade = options.onDowngrade;
    this.onError = options.onError;
  }
  get state() {
    return this.currentState;
  }
  get activePolicy() {
    return this.currentPolicy;
  }
  updateMode(mode) {
    this.bargeInMode = mode;
  }
  updateUsesSystemTts(usesSystemTts) {
    this.usesSystemTts = usesSystemTts;
  }
  /**
   * Start barge-in monitoring for an active TTS utterance/stream.
   * Returns the resolved policy (`'auto'` when actively monitoring, `'manual'` when downgraded or manual).
   */
  async start(overrides) {
    if (this.currentState !== "idle") {
      await this.stop();
    }
    const mode = overrides?.bargeInMode ?? this.bargeInMode;
    const usesSystemTts = overrides?.usesSystemTts ?? this.usesSystemTts;
    const isEdge = overrides?.isEdge ?? this.isEdge;
    const isSafari = overrides?.isSafari ?? this.isSafari;
    const isMobile = overrides?.isMobile ?? this.isMobile;
    const optimisticDecision = resolveBargeInPolicy({
      requestedMode: mode,
      usesSystemTts,
      isEdge,
      isSafari,
      isMobile,
      nativeAecActive: true
    });
    if (!optimisticDecision.allowHandsFreeBargeIn) {
      this.currentPolicy = "manual";
      if (optimisticDecision.reason !== "user-selected-manual") {
        this.emitDowngrade(optimisticDecision, null);
      }
      return {
        activePolicy: "manual",
        reason: optimisticDecision.reason,
        aecProbe: null
      };
    }
    const epoch = ++this.monitorEpoch;
    this.acceptingChunks = false;
    this.bargeInTriggered = false;
    this.consecutiveSpeechChunks = 0;
    this.nonSpeechChunksSinceReset = 0;
    this.currentPolicy = null;
    this.currentState = "starting";
    let acquiredHandle = null;
    try {
      const bufferedEarlyChunks = [];
      let vadReady = false;
      const handle = await this.captureAudio({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        chunkSamples: this.chunkSamples,
        workletUrl: this.workletUrl,
        deviceId: this.deviceId,
        onChunk: (chunk) => {
          if (!this.acceptingChunks || epoch !== this.monitorEpoch || this.bargeInTriggered)
            return;
          if (chunk.length === 0)
            return;
          const copy = chunk.slice();
          if (!vadReady) {
            bufferedEarlyChunks.push(copy);
            return;
          }
          this.enqueueVadChunk(copy, epoch);
        },
        onError: (err) => {
          if (epoch === this.monitorEpoch) {
            this.emitError(err);
          }
        }
      });
      acquiredHandle = handle;
      if (epoch !== this.monitorEpoch) {
        await this.cleanupStaleAttempt(handle);
        return {
          activePolicy: "manual",
          reason: "user-selected-manual",
          aecProbe: null
        };
      }
      const aecProbe = probeTrackAec(handle.track, handle.supportedConstraints);
      const decision = resolveBargeInPolicy({
        requestedMode: mode,
        usesSystemTts,
        isEdge,
        isSafari,
        isMobile,
        nativeAecActive: aecProbe.nativeAecActive
      });
      if (!decision.allowHandsFreeBargeIn) {
        await this.safeStopHandle(handle);
        if (epoch === this.monitorEpoch) {
          this.currentState = "idle";
          this.currentPolicy = "manual";
        }
        this.emitDowngrade(decision, aecProbe);
        return {
          activePolicy: "manual",
          reason: decision.reason,
          aecProbe
        };
      }
      this.captureHandle = handle;
      this.startedAtMs = nowMs();
      this.acceptingChunks = true;
      this.vadQueue = Promise.resolve();
      this.workerClient.setKeepAlive(true);
      await this.workerClient.ensureVadLoaded();
      if (epoch !== this.monitorEpoch) {
        await this.cleanupStaleAttempt(handle);
        return {
          activePolicy: "manual",
          reason: "user-selected-manual",
          aecProbe
        };
      }
      await this.workerClient.resetVad();
      if (epoch !== this.monitorEpoch) {
        await this.cleanupStaleAttempt(handle);
        return {
          activePolicy: "manual",
          reason: "user-selected-manual",
          aecProbe
        };
      }
      this.currentPolicy = "auto";
      this.currentState = "monitoring";
      vadReady = true;
      for (const early of bufferedEarlyChunks) {
        this.enqueueVadChunk(early, epoch);
      }
      bufferedEarlyChunks.length = 0;
      return {
        activePolicy: "auto",
        reason: "ok",
        aecProbe
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (epoch === this.monitorEpoch) {
        this.acceptingChunks = false;
        await this.teardownCapture();
        this.workerClient.setKeepAlive(false);
        this.currentState = "idle";
        this.currentPolicy = null;
        this.emitError(error);
      } else if (acquiredHandle) {
        await this.cleanupStaleAttempt(acquiredHandle);
      }
      throw error;
    }
  }
  /** Stop active microphone capture and cancel any pending VAD barge-in evaluations. */
  async stop() {
    if (this.currentState === "idle" && !this.captureHandle && !this.inFlightTeardown) {
      this.currentPolicy = null;
      return;
    }
    this.monitorEpoch++;
    this.acceptingChunks = false;
    this.consecutiveSpeechChunks = 0;
    this.currentState = "stopping";
    this.workerClient.setKeepAlive(false);
    await this.teardownCapture();
    this.currentPolicy = null;
    this.currentState = "idle";
  }
  enqueueVadChunk(chunk, epoch) {
    this.vadQueue = this.vadQueue.then(() => this.evaluateChunk(chunk, epoch)).catch((err) => {
      if (epoch === this.monitorEpoch && !this.bargeInTriggered) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
  async evaluateChunk(chunk, epoch) {
    if (!this.acceptingChunks || epoch !== this.monitorEpoch || this.bargeInTriggered)
      return;
    const rms = computeChunkRms(chunk);
    const vadRes = await this.workerClient.processVad(chunk);
    if (!this.acceptingChunks || epoch !== this.monitorEpoch || this.bargeInTriggered)
      return;
    if (vadRes.isSpeech && rms >= this.minRmsThreshold) {
      this.consecutiveSpeechChunks++;
      this.nonSpeechChunksSinceReset = 0;
    } else {
      this.consecutiveSpeechChunks = 0;
      this.nonSpeechChunksSinceReset++;
      if (this.nonSpeechChunksSinceReset >= 400) {
        this.nonSpeechChunksSinceReset = 0;
        await this.workerClient.resetVad();
      }
      return;
    }
    if (this.consecutiveSpeechChunks < this.confirmChunks) {
      return;
    }
    this.bargeInTriggered = true;
    this.acceptingChunks = false;
    const confirmedChunks = this.consecutiveSpeechChunks;
    const elapsedMs = Math.max(0, Math.round(nowMs() - this.startedAtMs));
    this.monitorEpoch++;
    this.currentState = "stopping";
    this.workerClient.setKeepAlive(false);
    await this.teardownCapture();
    this.currentPolicy = null;
    this.currentState = "idle";
    try {
      this.onBargeIn?.({
        elapsedMs,
        rms,
        confirmedChunks,
        speechProbability: vadRes.speechProbability
      });
    } catch {
    }
  }
  async teardownCapture() {
    const handle = this.captureHandle;
    this.captureHandle = null;
    if (handle) {
      const p2 = this.safeStopHandle(handle).finally(() => {
        if (this.inFlightTeardown === p2) {
          this.inFlightTeardown = null;
        }
      });
      this.inFlightTeardown = p2;
      await p2;
    } else if (this.inFlightTeardown) {
      await this.inFlightTeardown;
    }
  }
  async cleanupStaleAttempt(handle) {
    if (this.captureHandle === handle) {
      this.captureHandle = null;
    }
    await this.safeStopHandle(handle);
  }
  async safeStopHandle(handle) {
    try {
      await handle.stop();
    } catch {
    }
  }
  emitDowngrade(decision, aecProbe) {
    try {
      this.onDowngrade?.(decision, aecProbe);
    } catch {
    }
  }
  emitError(err) {
    try {
      this.onError?.(err);
    } catch {
    }
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/cloud-dictation-session.js
var DEFAULT_CLOUD_SPEECH_RMS_THRESHOLD = 8e-3;
var DEFAULT_CLOUD_MIN_SPEECH_MS = 160;
var INTER_UTTERANCE_SILENCE_LEAD_SAMPLES2 = Math.round(0.16 * TARGET_SAMPLE_RATE);
var PTT_MIN_DURATION_MS2 = 150;
var PTT_MIN_SAMPLES2 = Math.round(PTT_MIN_DURATION_MS2 / 1e3 * TARGET_SAMPLE_RATE);
var PTT_MIN_PEAK_RMS = 2e-3;
var RMS_WINDOW_SAMPLES = 512;
function concatFloat32Chunks(chunks, totalSamples) {
  if (totalSamples <= 0 || chunks.length === 0)
    return new Float32Array(0);
  if (chunks.length === 1 && chunks[0].length === totalSamples)
    return chunks[0];
  const out = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, totalSamples - offset);
    if (take <= 0)
      break;
    out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}
function computePeakWindowRms(samples) {
  if (samples.length === 0)
    return 0;
  let peakRms = 0;
  for (let offset = 0; offset < samples.length; offset += RMS_WINDOW_SAMPLES) {
    const end = Math.min(samples.length, offset + RMS_WINDOW_SAMPLES);
    const len = end - offset;
    let sumSq = 0;
    for (let i = offset; i < end; i++) {
      const v = samples[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / len);
    if (rms > peakRms)
      peakRms = rms;
  }
  return peakRms;
}
var CloudDictationSession = class {
  transport;
  captureAudio;
  policy;
  language;
  speechRmsThreshold;
  minSpeechMs;
  workletUrl;
  deviceId;
  onStateChange;
  onSpeechActivity;
  onFinalTranscript;
  onError;
  currentState = "idle";
  currentMode = "toggle";
  sessionEpoch = 0;
  captureHandle = null;
  inFlightTeardown = null;
  acceptingChunks = false;
  speechActive = false;
  singleUtteranceTriggered = false;
  // 640 ms (10,240 samples @ 16 kHz) pre-roll ring buffer
  preRollRing = new Float32Array(DICTATION_PRE_ROLL_SAMPLES);
  preRollWritePos = 0;
  preRollCount = 0;
  // Candidate speech onset frames buffered until `minSpeechMs` is confirmed so single-frame
  // clicks never trigger utterances AND never overwrite the 640 ms pre-roll before true onset.
  pendingSpeechChunks = [];
  pendingSpeechSamples = 0;
  continuingSpeechFromCap = false;
  // Active utterance / push-to-talk accumulator
  inUtterance = false;
  utteranceChunks = [];
  utteranceSamples = 0;
  trailingSilenceSamples = 0;
  // Serialized transport transcription queue & active AbortControllers
  transcribeQueue = Promise.resolve();
  inFlightControllers = /* @__PURE__ */ new Set();
  stoppingPromise = null;
  singleFinalizePromise = null;
  constructor(options) {
    const hasTranscribe = typeof options.transport?.transcribe === "function";
    const hasStreaming = typeof options.transport?.start === "function" && typeof options.transport?.pushAudio === "function" && typeof options.transport?.finalize === "function";
    if (!hasTranscribe && !hasStreaming) {
      throw new Error("CloudDictationSession requires an AsrTransport implementing transcribe() or start()/pushAudio()/finalize()");
    }
    this.transport = options.transport;
    this.captureAudio = options.captureAudio ?? createBrowserMicCapture;
    this.policy = resolveEndpointPolicy(options.endpointPolicy);
    this.language = options.language;
    this.speechRmsThreshold = typeof options.speechRmsThreshold === "number" && Number.isFinite(options.speechRmsThreshold) ? Math.max(0, options.speechRmsThreshold) : DEFAULT_CLOUD_SPEECH_RMS_THRESHOLD;
    this.minSpeechMs = typeof options.minSpeechMs === "number" && Number.isFinite(options.minSpeechMs) ? Math.max(0, options.minSpeechMs) : DEFAULT_CLOUD_MIN_SPEECH_MS;
    this.workletUrl = options.workletUrl;
    this.deviceId = options.deviceId;
    this.onStateChange = options.onStateChange;
    this.onSpeechActivity = options.onSpeechActivity;
    this.onFinalTranscript = options.onFinalTranscript;
    this.onError = options.onError;
  }
  get state() {
    return this.currentState;
  }
  get mode() {
    return this.currentMode;
  }
  updateEndpointPolicy(partial) {
    this.policy = resolveEndpointPolicy({
      ...this.policy,
      ...partial.silenceMs !== void 0 ? { silenceMs: partial.silenceMs } : {},
      ...partial.maxSpeechSec !== void 0 ? { maxSpeechSec: partial.maxSpeechSec } : {},
      ...partial.vadThreshold !== void 0 ? { vadThreshold: partial.vadThreshold } : {},
      ...partial.detectVadThreshold !== void 0 ? { detectVadThreshold: partial.detectVadThreshold } : {}
    });
  }
  updateLanguage(language) {
    this.language = language;
  }
  async start(mode = "toggle") {
    if (this.currentState !== "idle") {
      throw new Error(`Cannot start dictation while session state is "${this.currentState}"`);
    }
    const epoch = ++this.sessionEpoch;
    this.currentMode = mode;
    this.stoppingPromise = null;
    this.singleFinalizePromise = null;
    this.singleUtteranceTriggered = false;
    this.acceptingChunks = false;
    this.resetAudioBuffers();
    this.setSpeechActive(false);
    this.transcribeQueue = Promise.resolve();
    this.setState("starting");
    let acquiredHandle = null;
    try {
      const handle = await this.captureAudio({
        onChunk: (chunk) => this.onCapturedChunk(chunk, epoch),
        onError: (err) => {
          if (epoch === this.sessionEpoch) {
            this.emitError(err);
          }
        },
        workletUrl: this.workletUrl,
        deviceId: this.deviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      });
      acquiredHandle = handle;
      if (epoch !== this.sessionEpoch) {
        await this.cleanupStaleAttempt(handle);
        return;
      }
      this.captureHandle = handle;
      this.acceptingChunks = true;
      this.setState("listening");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (epoch === this.sessionEpoch) {
        this.acceptingChunks = false;
        await this.teardownCapture();
        this.setState("idle");
        this.emitError(error);
        throw error;
      }
      if (acquiredHandle) {
        await this.cleanupStaleAttempt(acquiredHandle);
      }
    }
  }
  async stop(options) {
    if (this.currentState === "idle")
      return;
    const flush = options?.flush ?? true;
    if (!flush) {
      await this.abort();
      return;
    }
    if (this.stoppingPromise) {
      return this.stoppingPromise;
    }
    const epoch = this.sessionEpoch;
    const mode = this.currentMode;
    const runStop = async () => {
      if (this.currentState === "starting") {
        const cancelEpoch = ++this.sessionEpoch;
        await this.teardownCapture();
        if (cancelEpoch === this.sessionEpoch) {
          this.resetAudioBuffers();
          this.setSpeechActive(false);
          this.setState("idle");
        }
        return;
      }
      if (this.singleFinalizePromise) {
        await this.singleFinalizePromise;
        return;
      }
      this.acceptingChunks = false;
      if (this.currentState !== "transcribing") {
        this.setState("stopping");
      }
      await this.teardownCapture();
      if (epoch !== this.sessionEpoch)
        return;
      if (mode === "push-to-talk") {
        const pcm = this.takeBufferedUtterance();
        this.setSpeechActive(false);
        if (pcm.length >= PTT_MIN_SAMPLES2 && computePeakWindowRms(pcm) >= PTT_MIN_PEAK_RMS) {
          this.setState("transcribing");
          this.enqueueTranscription(pcm, mode, epoch);
          await this.transcribeQueue;
        }
      } else {
        if (this.inUtterance && this.utteranceSamples > 0) {
          const flushed = this.takeBufferedUtterance();
          this.setSpeechActive(false);
          if (flushed.length > 0) {
            this.enqueueTranscription(flushed, mode, epoch);
          }
        } else {
          this.resetAudioBuffers();
          this.setSpeechActive(false);
        }
        this.setState("transcribing");
        await this.transcribeQueue;
      }
      if (epoch === this.sessionEpoch) {
        this.setState("idle");
      }
    };
    const p2 = runStop().finally(() => {
      if (this.stoppingPromise === p2) {
        this.stoppingPromise = null;
      }
    });
    this.stoppingPromise = p2;
    return p2;
  }
  /**
   * Immediately cancel all buffered audio and in-flight transport requests, tear down mic capture,
   * and reset state to `'idle'` without firing `onFinalTranscript` or false `onError`.
   */
  async abort() {
    if (this.currentState === "idle" && !this.captureHandle && !this.inFlightTeardown && this.inFlightControllers.size === 0) {
      return;
    }
    const abortEpoch = ++this.sessionEpoch;
    this.acceptingChunks = false;
    this.stoppingPromise = null;
    this.singleFinalizePromise = null;
    this.abortInFlightTransports();
    this.resetAudioBuffers();
    this.setSpeechActive(false);
    await this.teardownCapture();
    if (abortEpoch === this.sessionEpoch) {
      this.setState("idle");
    }
  }
  onCapturedChunk(chunk, epoch) {
    if (!this.acceptingChunks || epoch !== this.sessionEpoch || chunk.length === 0)
      return;
    if (this.currentMode === "single" && this.singleUtteranceTriggered)
      return;
    if (this.currentMode === "push-to-talk") {
      const maxSamples = Math.round(this.policy.maxSpeechSec * TARGET_SAMPLE_RATE);
      const remaining = maxSamples - this.utteranceSamples;
      if (remaining <= 0)
        return;
      const copy = chunk.length <= remaining ? chunk.slice() : chunk.subarray(0, remaining).slice();
      this.utteranceChunks.push(copy);
      this.utteranceSamples += copy.length;
      const hasVoice = computePeakWindowRms(copy) >= PTT_MIN_PEAK_RMS;
      if (hasVoice && !this.speechActive) {
        this.setSpeechActive(true);
      }
      return;
    }
    const owned = chunk.slice();
    const isSpeech = computeChunkRms(owned) >= this.speechRmsThreshold;
    const minSpeechSamples = this.minSpeechMs <= 0 ? 0 : Math.round(this.minSpeechMs / 1e3 * TARGET_SAMPLE_RATE);
    if (!this.inUtterance) {
      if (!isSpeech) {
        this.continuingSpeechFromCap = false;
        this.setSpeechActive(false);
        if (this.pendingSpeechSamples > 0) {
          for (const pendingChunk of this.pendingSpeechChunks) {
            this.pushPreRoll(pendingChunk);
          }
          this.pendingSpeechChunks = [];
          this.pendingSpeechSamples = 0;
        }
        this.pushPreRoll(owned);
        return;
      }
      if (this.continuingSpeechFromCap) {
        this.continuingSpeechFromCap = false;
        this.inUtterance = true;
        this.trailingSilenceSamples = 0;
        this.setSpeechActive(true);
        this.appendChunkToUtterance(owned, true, epoch);
        return;
      }
      if (this.pendingSpeechSamples + owned.length < minSpeechSamples) {
        this.pendingSpeechChunks.push(owned);
        this.pendingSpeechSamples += owned.length;
        return;
      }
      this.inUtterance = true;
      this.trailingSilenceSamples = 0;
      this.setSpeechActive(true);
      const preRoll = this.drainPreRoll();
      const pending = this.pendingSpeechChunks;
      this.pendingSpeechChunks = [];
      this.pendingSpeechSamples = 0;
      if (preRoll.length > 0) {
        this.appendChunkToUtterance(preRoll, true, epoch);
      }
      for (const pendingChunk of pending) {
        this.appendChunkToUtterance(pendingChunk, true, epoch);
      }
      this.appendChunkToUtterance(owned, true, epoch);
      return;
    }
    this.appendChunkToUtterance(owned, isSpeech, epoch);
  }
  appendChunkToUtterance(chunk, isSpeech, epoch) {
    let cursor = chunk;
    while (cursor.length > 0) {
      if (epoch !== this.sessionEpoch)
        return;
      if (this.currentMode === "single" && this.singleUtteranceTriggered)
        return;
      const maxSpeechSamples = Math.round(this.policy.maxSpeechSec * TARGET_SAMPLE_RATE);
      const silenceTargetSamples = Math.round(this.policy.silenceMs / 1e3 * TARGET_SAMPLE_RATE);
      const room = Math.max(0, maxSpeechSamples - this.utteranceSamples);
      const head = cursor.length <= room ? cursor : cursor.subarray(0, room);
      const overflow = cursor.length > room ? cursor.subarray(room) : null;
      if (head.length > 0) {
        this.utteranceChunks.push(head);
        this.utteranceSamples += head.length;
      }
      if (isSpeech) {
        this.setSpeechActive(true);
        this.trailingSilenceSamples = 0;
      } else {
        this.setSpeechActive(false);
        this.trailingSilenceSamples += head.length;
      }
      const hitSilenceEndpoint = !isSpeech && this.trailingSilenceSamples >= silenceTargetSamples;
      const hitMaxSpeechCap = this.utteranceSamples >= maxSpeechSamples;
      if (!hitSilenceEndpoint && !hitMaxSpeechCap) {
        return;
      }
      const trailingSilenceBeforeTake = this.trailingSilenceSamples;
      const completedPcm = this.takeBufferedUtterance();
      const mode = this.currentMode;
      if (mode === "single") {
        this.singleUtteranceTriggered = true;
        this.acceptingChunks = false;
        this.setSpeechActive(false);
        const p2 = this.finishSingleUtterance(completedPcm, epoch).finally(() => {
          if (this.singleFinalizePromise === p2) {
            this.singleFinalizePromise = null;
          }
        });
        this.singleFinalizePromise = p2;
        return;
      }
      if (hitSilenceEndpoint && trailingSilenceBeforeTake > 0 && completedPcm.length > 0) {
        const leadLen = Math.min(INTER_UTTERANCE_SILENCE_LEAD_SAMPLES2, trailingSilenceBeforeTake, completedPcm.length);
        if (leadLen > 0) {
          this.pushPreRoll(completedPcm.subarray(completedPcm.length - leadLen));
        }
      }
      if (completedPcm.length > 0) {
        this.enqueueTranscription(completedPcm, mode, epoch);
      }
      if (overflow && overflow.length > 0) {
        if (isSpeech) {
          this.inUtterance = true;
          this.trailingSilenceSamples = 0;
          cursor = overflow.slice();
          continue;
        }
        this.continuingSpeechFromCap = false;
        this.pushPreRoll(overflow);
        return;
      }
      this.continuingSpeechFromCap = hitMaxSpeechCap && isSpeech;
      return;
    }
  }
  async finishSingleUtterance(completedPcm, epoch) {
    await this.teardownCapture();
    if (epoch !== this.sessionEpoch)
      return;
    this.setState("transcribing");
    if (completedPcm.length > 0) {
      this.enqueueTranscription(completedPcm, "single", epoch);
    }
    await this.transcribeQueue;
    if (epoch === this.sessionEpoch) {
      this.setState("idle");
    }
  }
  enqueueTranscription(pcm, mode, epoch) {
    const language = this.language;
    const policy = this.policy;
    this.transcribeQueue = this.transcribeQueue.then(async () => {
      if (epoch !== this.sessionEpoch)
        return;
      const controller = new AbortController();
      this.inFlightControllers.add(controller);
      try {
        const res = await this.runTransportTranscribe(pcm, language, policy, controller.signal);
        if (epoch !== this.sessionEpoch || controller.signal.aborted)
          return;
        const text = res.text.trim();
        if (text.length > 0) {
          const durationMs = typeof res.durationMs === "number" && res.durationMs > 0 ? res.durationMs : Math.round(pcm.length / TARGET_SAMPLE_RATE * 1e3);
          try {
            this.onFinalTranscript?.(text, { durationMs, mode });
          } catch {
          }
        }
      } catch (err) {
        if (epoch === this.sessionEpoch && !controller.signal.aborted) {
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        this.inFlightControllers.delete(controller);
      }
    });
  }
  async runTransportTranscribe(pcm, language, policy, signal) {
    if (typeof this.transport.transcribe === "function") {
      return this.transport.transcribe(pcm, {
        sampleRate: TARGET_SAMPLE_RATE,
        language,
        signal
      });
    }
    if (typeof this.transport.start === "function" && typeof this.transport.pushAudio === "function" && typeof this.transport.finalize === "function") {
      await this.transport.start({
        language,
        policy,
        signal
      });
      if (signal.aborted) {
        return { text: "", isFinal: true };
      }
      this.transport.pushAudio(pcm);
      return this.transport.finalize(signal);
    }
    throw new Error("AsrTransport must implement transcribe() or start()/pushAudio()/finalize()");
  }
  abortInFlightTransports() {
    for (const controller of this.inFlightControllers) {
      try {
        controller.abort();
      } catch {
      }
    }
    this.inFlightControllers.clear();
    try {
      this.transport.abort?.();
    } catch {
    }
  }
  pushPreRoll(chunk) {
    const cap = DICTATION_PRE_ROLL_SAMPLES;
    if (chunk.length >= cap) {
      this.preRollRing.set(chunk.subarray(chunk.length - cap), 0);
      this.preRollWritePos = 0;
      this.preRollCount = cap;
      return;
    }
    const firstPart = Math.min(chunk.length, cap - this.preRollWritePos);
    this.preRollRing.set(chunk.subarray(0, firstPart), this.preRollWritePos);
    if (firstPart < chunk.length) {
      this.preRollRing.set(chunk.subarray(firstPart), 0);
    }
    this.preRollWritePos = (this.preRollWritePos + chunk.length) % cap;
    this.preRollCount = Math.min(cap, this.preRollCount + chunk.length);
  }
  drainPreRoll() {
    const count = this.preRollCount;
    if (count === 0)
      return new Float32Array(0);
    const cap = DICTATION_PRE_ROLL_SAMPLES;
    const out = new Float32Array(count);
    const start = (this.preRollWritePos - count + cap) % cap;
    const tailLen = Math.min(count, cap - start);
    out.set(this.preRollRing.subarray(start, start + tailLen), 0);
    if (tailLen < count) {
      out.set(this.preRollRing.subarray(0, count - tailLen), tailLen);
    }
    this.preRollWritePos = 0;
    this.preRollCount = 0;
    return out;
  }
  takeBufferedUtterance() {
    const pcm = concatFloat32Chunks(this.utteranceChunks, this.utteranceSamples);
    this.inUtterance = false;
    this.utteranceChunks = [];
    this.utteranceSamples = 0;
    this.trailingSilenceSamples = 0;
    return pcm;
  }
  resetAudioBuffers() {
    this.preRollWritePos = 0;
    this.preRollCount = 0;
    this.pendingSpeechChunks = [];
    this.pendingSpeechSamples = 0;
    this.continuingSpeechFromCap = false;
    this.inUtterance = false;
    this.utteranceChunks = [];
    this.utteranceSamples = 0;
    this.trailingSilenceSamples = 0;
  }
  async teardownCapture() {
    const handle = this.captureHandle;
    this.captureHandle = null;
    if (handle) {
      const p2 = this.safeStopHandle(handle).finally(() => {
        if (this.inFlightTeardown === p2) {
          this.inFlightTeardown = null;
        }
      });
      this.inFlightTeardown = p2;
      await p2;
    } else if (this.inFlightTeardown) {
      await this.inFlightTeardown;
    }
  }
  async cleanupStaleAttempt(handle) {
    if (this.captureHandle === handle) {
      this.captureHandle = null;
    }
    await this.safeStopHandle(handle);
  }
  async safeStopHandle(handle) {
    try {
      await handle.stop();
    } catch {
    }
  }
  setState(next) {
    if (this.currentState === next)
      return;
    this.currentState = next;
    try {
      this.onStateChange?.(next);
    } catch {
    }
  }
  setSpeechActive(active) {
    if (this.speechActive === active)
      return;
    this.speechActive = active;
    try {
      this.onSpeechActivity?.(active);
    } catch {
    }
  }
  emitError(err) {
    try {
      this.onError?.(err);
    } catch {
    }
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/focus-injector.js
var MAX_ACTIVE_ELEMENT_DEPTH = 16;
var NON_TEXT_INPUT_TYPES = /* @__PURE__ */ new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week"
]);
function asDuckElement(el) {
  return el;
}
function hasHostInstanceOf(el) {
  return typeof asDuckElement(el).instanceOf === "function";
}
function isTextAreaElement(el) {
  if (hasHostInstanceOf(el) && typeof HTMLTextAreaElement !== "undefined") {
    return Boolean(asDuckElement(el).instanceOf?.(HTMLTextAreaElement));
  }
  return el.tagName.toUpperCase() === "TEXTAREA";
}
function isInputElement(el) {
  if (hasHostInstanceOf(el) && typeof HTMLInputElement !== "undefined") {
    return Boolean(asDuckElement(el).instanceOf?.(HTMLInputElement));
  }
  return el.tagName.toUpperCase() === "INPUT";
}
function isEditableHtmlElement(el) {
  if (hasHostInstanceOf(el) && typeof HTMLElement !== "undefined") {
    return Boolean(asDuckElement(el).instanceOf?.(HTMLElement)) && el.isContentEditable === true;
  }
  return el.isContentEditable === true;
}
function resolveFallbackWindow(el, explicitWin) {
  if (explicitWin !== void 0) {
    return explicitWin;
  }
  const docWin = el.ownerDocument?.defaultView ?? null;
  if (docWin) {
    return docWin;
  }
  if (typeof window !== "undefined") {
    const maybeActive = window.activeWindow;
    return maybeActive ?? window;
  }
  return null;
}
function setNativeInputValue(el, nextValue, win) {
  const proto = isTextAreaElement(el) ? win?.HTMLTextAreaElement?.prototype : win?.HTMLInputElement?.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "value") : void 0;
  if (descriptor && typeof descriptor.set === "function") {
    descriptor.set.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
}
function dispatchInsertInputEvent(el, text, win) {
  const InputEventCtor = win?.InputEvent ?? (typeof InputEvent === "function" ? InputEvent : void 0);
  const EventCtor = win?.Event ?? Event;
  const evt = typeof InputEventCtor === "function" ? new InputEventCtor("input", {
    bubbles: true,
    cancelable: false,
    data: text,
    inputType: "insertText"
  }) : new EventCtor("input", { bubbles: true, cancelable: false });
  el.dispatchEvent(evt);
}
function resolveDeepActiveElement(doc) {
  let current = doc.activeElement;
  let depth = 0;
  while (current && depth < MAX_ACTIVE_ELEMENT_DEPTH) {
    depth += 1;
    const shadowActive = current.shadowRoot?.activeElement ?? null;
    if (shadowActive && shadowActive !== current) {
      current = shadowActive;
      continue;
    }
    if (current.tagName.toUpperCase() === "IFRAME") {
      try {
        const frameDoc = current.contentDocument;
        const frameActive = frameDoc?.activeElement ?? null;
        if (frameActive && frameActive !== current) {
          current = frameActive;
          continue;
        }
      } catch {
        break;
      }
    }
    break;
  }
  return current;
}
function insertIntoInputOrTextarea(el, text, explicitWin) {
  if (!text || el.disabled || el.readOnly) {
    return false;
  }
  if (isInputElement(el) && NON_TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase())) {
    return false;
  }
  const win = resolveFallbackWindow(el, explicitWin);
  const current = el.value;
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const nextValue = `${current.slice(0, start)}${text}${current.slice(end)}`;
  const nextCaret = start + text.length;
  setNativeInputValue(el, nextValue, win);
  if (typeof el.setSelectionRange === "function") {
    try {
      el.setSelectionRange(nextCaret, nextCaret);
    } catch {
    }
  }
  dispatchInsertInputEvent(el, text, win);
  return true;
}
function dispatchSyntheticPaste(el, text, explicitWin) {
  if (!text) {
    return false;
  }
  const win = resolveFallbackWindow(el, explicitWin);
  const DataTransferCtor = win?.DataTransfer ?? (win === null && typeof DataTransfer === "function" ? DataTransfer : void 0);
  const ClipboardEventCtor = win?.ClipboardEvent ?? (win === null && typeof ClipboardEvent === "function" ? ClipboardEvent : void 0);
  if (typeof DataTransferCtor !== "function" || typeof ClipboardEventCtor !== "function") {
    return false;
  }
  try {
    const dt = new DataTransferCtor();
    dt.setData("text/plain", text);
    const pasteEvt = new ClipboardEventCtor("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });
    const notCancelled = el.dispatchEvent(pasteEvt);
    return !notCancelled || pasteEvt.defaultPrevented;
  } catch {
    return false;
  }
}
function insertIntoFocusedInput(doc, text, replacer) {
  const transformed = replacer ? replacer(text) : text;
  const cleanText = transformed.trim();
  if (!cleanText) {
    return false;
  }
  const active = resolveDeepActiveElement(doc);
  if (!active) {
    return false;
  }
  const targetDoc = active.ownerDocument ?? doc;
  const win = targetDoc.defaultView ?? doc.defaultView ?? resolveFallbackWindow(active);
  if (isTextAreaElement(active) || isInputElement(active)) {
    return insertIntoInputOrTextarea(active, cleanText, win);
  }
  if (isEditableHtmlElement(active)) {
    if (dispatchSyntheticPaste(active, cleanText, win)) {
      return true;
    }
    const selection = win?.getSelection ? win.getSelection() : null;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (active.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        const textNode = targetDoc.createTextNode(cleanText);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        dispatchInsertInputEvent(active, cleanText, win);
        return true;
      }
    }
    const hostEl = asDuckElement(active);
    if (typeof hostEl.appendText === "function") {
      hostEl.appendText(cleanText);
    } else {
      active.appendChild(targetDoc.createTextNode(cleanText));
    }
    dispatchInsertInputEvent(active, cleanText, win);
    return true;
  }
  return false;
}
var FocusTextInjector = class {
  replacer;
  constructor(options = {}) {
    this.replacer = options.replacer;
  }
  updateReplacer(replacer) {
    this.replacer = replacer;
  }
  resolveActiveElement(doc) {
    return resolveDeepActiveElement(doc);
  }
  inject(doc, text, replacerOverride) {
    return insertIntoFocusedInput(doc, text, replacerOverride ?? this.replacer);
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/system-tts-playback.js
var SYSTEM_TTS_MIME = "application/x-voice-mode-system-tts";
function abortableDelay(ms, signal) {
  if (ms <= 0 || signal.aborted)
    return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      cancelTimeout(timer);
      resolve();
    };
    const timer = scheduleTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function computeLeadingBreakMs(rawText) {
  let sum = 0;
  let rest = rawText;
  const leadRe = /^\s*<\s*break\s+(\d+)\s*ms\s*>/i;
  while (true) {
    const m = leadRe.exec(rest);
    if (!m)
      break;
    sum += Math.min(5e3, Math.max(0, Number(m[1] ?? 0)));
    rest = rest.slice(m[0].length);
  }
  return Math.min(1e4, sum);
}
function buildSystemTtsSegments(rawText, segments) {
  if (segments.length === 0)
    return [];
  const leadingBreak = computeLeadingBreakMs(rawText);
  return segments.map((seg, idx) => {
    const attached = Math.max(0, Math.min(5e3, seg.preBreakMs ?? 0));
    const rateScale = seg.slow ? 0.85 : seg.fast ? 1.15 : 1;
    if (idx === 0 && leadingBreak > 0) {
      const pre = Math.min(leadingBreak, attached);
      return {
        text: seg.text,
        whisper: seg.whisper,
        preBreakMs: pre,
        breakAfterMs: Math.max(0, attached - pre),
        rateScale
      };
    }
    return {
      text: seg.text,
      whisper: seg.whisper,
      preBreakMs: 0,
      breakAfterMs: attached,
      rateScale
    };
  });
}
var SystemTtsEngine = class {
  kind = "system";
  mime = SYSTEM_TTS_MIME;
  defaultVoice = "";
  defaultRate = 1;
  updateVoice(voice, rate) {
    this.defaultVoice = voice;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
      this.defaultRate = rate;
    }
  }
  async synthesize(text, options) {
    const segments = options?.segments && options.segments.length > 0 ? options.segments : [{ text, whisper: false, preBreakMs: 0, breakAfterMs: 0 }];
    const payload = {
      text,
      voice: options?.voice ?? this.defaultVoice,
      rate: options?.rate ?? this.defaultRate,
      segments
    };
    return {
      audio: new TextEncoder().encode(JSON.stringify(payload)),
      mime: SYSTEM_TTS_MIME
    };
  }
  interrupt() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
      }
    }
  }
  async close() {
    this.interrupt();
  }
};
var BrowserAudioSink = class {
  sharedAudio = null;
  activeObjectUrl = null;
  audioPlaying = false;
  async play(payload, signal) {
    if (signal.aborted)
      return;
    if (payload.mime === SYSTEM_TTS_MIME) {
      await this.playSystemUtterance(payload.audio, signal);
      return;
    }
    await this.playAudioBytes(payload, signal);
  }
  pause() {
    if (this.audioPlaying && this.sharedAudio) {
      this.sharedAudio.pause();
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
    }
  }
  resume() {
    if (this.audioPlaying && this.sharedAudio) {
      void this.sharedAudio.play().catch(() => void 0);
    } else if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
    }
  }
  stop() {
    this.resetSharedAudio();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
      }
    }
  }
  resetSharedAudio() {
    this.audioPlaying = false;
    if (this.sharedAudio) {
      try {
        this.sharedAudio.onended = null;
        this.sharedAudio.onerror = null;
        this.sharedAudio.pause();
        this.sharedAudio.removeAttribute("src");
        this.sharedAudio.load();
      } catch {
      }
    }
    if (this.activeObjectUrl && typeof URL !== "undefined") {
      try {
        URL.revokeObjectURL(this.activeObjectUrl);
      } catch {
      }
      this.activeObjectUrl = null;
    }
  }
  async speakSingleSystemSegment(text, voiceName, rate, whisper, signal) {
    if (signal.aborted || !text.trim())
      return;
    const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
    const UtteranceCtor = typeof SpeechSynthesisUtterance !== "undefined" ? SpeechSynthesisUtterance : null;
    const voices = synth ? synth.getVoices() : [];
    if (!synth || !UtteranceCtor || voices.length === 0) {
      const durationMs = Math.min(900, Math.max(100, text.length * 16));
      await abortableDelay(durationMs, signal);
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled)
          return;
        settled = true;
        cancelTimeout(safetyTimer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        try {
          synth.cancel();
        } catch {
        }
        finish();
      };
      const utterance = new UtteranceCtor(text);
      if (voiceName) {
        const matched = voices.find((v) => v.name === voiceName || v.voiceURI === voiceName || v.lang === voiceName);
        if (matched)
          utterance.voice = matched;
      }
      utterance.rate = rate || 1;
      utterance.volume = whisper ? 0.65 : 1;
      utterance.onend = finish;
      utterance.onerror = finish;
      const maxExpectedMs = Math.min(2e4, Math.max(2500, text.length * 120));
      const safetyTimer = scheduleTimeout(finish, maxExpectedMs);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
  }
  async playSystemUtterance(encoded, signal) {
    const parsed = JSON.parse(new TextDecoder().decode(encoded));
    const segs = Array.isArray(parsed.segments) && parsed.segments.length > 0 ? parsed.segments : [{ text: parsed.text, whisper: false, preBreakMs: 0, breakAfterMs: 0 }];
    for (const seg of segs) {
      if (signal.aborted)
        return;
      if (seg.preBreakMs > 0) {
        await abortableDelay(seg.preBreakMs, signal);
      }
      if (signal.aborted)
        return;
      await this.speakSingleSystemSegment(seg.text, parsed.voice, parsed.rate * (seg.rateScale ?? 1), seg.whisper, signal);
      if (signal.aborted)
        return;
      if (seg.breakAfterMs > 0) {
        await abortableDelay(seg.breakAfterMs, signal);
      }
    }
  }
  async playAudioBytes(payload, signal) {
    if (typeof Audio === "undefined" || typeof URL === "undefined") {
      await abortableDelay(80, signal);
      return;
    }
    this.resetSharedAudio();
    const copy = new Uint8Array(payload.audio.byteLength);
    copy.set(payload.audio);
    const blob = new Blob([copy], { type: payload.mime || "audio/wav" });
    const objectUrl = URL.createObjectURL(blob);
    const audio = this.sharedAudio ??= new Audio();
    audio.src = objectUrl;
    this.activeObjectUrl = objectUrl;
    this.audioPlaying = true;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled)
          return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.resetSharedAudio();
        resolve();
      };
      const onAbort = () => {
        finish();
      };
      audio.onended = finish;
      audio.onerror = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      void audio.play().catch(() => finish());
    });
  }
};

// node_modules/.pnpm/@voice-mode+browser@file+vendor+voice-mode-browser-0.1.0.tgz/node_modules/@voice-mode/browser/dist/duplex-protocol.js
function clampRatio(value) {
  if (typeof value !== "number" || !Number.isFinite(value))
    return 0.2;
  return Math.min(1, Math.max(0, value));
}
var DuplexProtocol = class {
  state = "idle";
  speechActive = false;
  playbackActive = false;
  duckOnOverlap;
  /** Duck ratio hosts should apply when they act on `duck-playback`. */
  duckRatio;
  constructor(options = {}) {
    this.duckOnOverlap = options.duckOnOverlap ?? true;
    this.duckRatio = clampRatio(options.duckRatio);
  }
  snapshot() {
    return {
      state: this.state,
      speechActive: this.speechActive,
      playbackActive: this.playbackActive
    };
  }
  reset() {
    this.state = "idle";
    this.speechActive = false;
    this.playbackActive = false;
  }
  /**
   * Feed one event and receive the actions the host must apply. Actions are
   * ordered: stop/duck playback before cancelling generation, then capture.
   */
  feed(event) {
    const from = this.state;
    const actions = /* @__PURE__ */ new Set();
    switch (event.type) {
      case "speech-start": {
        this.speechActive = true;
        if (this.playbackActive) {
          this.state = "overlap";
          if (this.duckOnOverlap) {
            actions.add("duck-playback");
          } else {
            actions.add("stop-playback");
            actions.add("cancel-generation");
          }
        } else {
          this.state = "listening";
        }
        break;
      }
      case "speech-end": {
        this.speechActive = false;
        if (this.state === "barge-in") {
          this.state = "idle";
        } else if (this.playbackActive) {
          this.state = "speaking";
        } else {
          this.state = "idle";
        }
        break;
      }
      case "playback-start": {
        this.playbackActive = true;
        if (this.speechActive) {
          this.state = "overlap";
          if (this.duckOnOverlap) {
            actions.add("duck-playback");
          } else {
            actions.add("stop-playback");
          }
        } else {
          this.state = "speaking";
        }
        break;
      }
      case "playback-end": {
        this.playbackActive = false;
        if (this.speechActive) {
          this.state = "listening";
        } else if (this.state === "barge-in") {
          this.state = "idle";
        } else {
          this.state = "idle";
        }
        break;
      }
      case "barge-in": {
        this.speechActive = true;
        this.playbackActive = false;
        this.state = "barge-in";
        actions.add("stop-playback");
        actions.add("cancel-generation");
        actions.add("flush-queue");
        actions.add("start-capture");
        break;
      }
      case "yield": {
        this.speechActive = false;
        if (this.playbackActive) {
          actions.add("stop-playback");
        }
        actions.add("stop-capture");
        this.state = "idle";
        break;
      }
      case "reset": {
        this.reset();
        break;
      }
      default: {
        const exhaustive = event.type;
        void exhaustive;
      }
    }
    return { from, to: this.state, actions: [...actions] };
  }
};

// src/tts-hub.ts
function resolveUtteranceVoice(utterance, settings, cardVoiceRaw) {
  if (utterance.role === "narrator" && settings.narrationSplitEnabled) {
    const narrator = settings.narratorVoice;
    if (narrator.voice || narrator.engine !== settings.defaultVoice.engine) {
      return narrator;
    }
    return settings.defaultVoice;
  }
  if (utterance.avatar && settings.voiceMap[utterance.avatar]) {
    return settings.voiceMap[utterance.avatar];
  }
  if (utterance.speaker && settings.voiceMap[utterance.speaker]) {
    return settings.voiceMap[utterance.speaker];
  }
  if (utterance.speaker) {
    const needle = utterance.speaker.toLowerCase();
    for (const [k, v] of Object.entries(settings.voiceMap)) {
      if (k.toLowerCase() === needle) return v;
    }
  }
  if (cardVoiceRaw && typeof cardVoiceRaw === "object") {
    return normalizeVoiceAssignment(cardVoiceRaw, settings.defaultVoice.engine);
  }
  return settings.defaultVoice;
}
var SERVER_PLUGIN_HEALTH_TTL_MS = 15e3;
var VoiceModeTtsHub = class {
  options;
  systemEngine = new SystemTtsEngine();
  sink;
  queue;
  daemonClient = null;
  daemonClientUrl = "";
  serverPluginState = null;
  pendingInfo = /* @__PURE__ */ new Map();
  seq = 0;
  lastUsesSystemTts = true;
  constructor(options) {
    this.options = options;
    this.sink = options.sink ?? new BrowserAudioSink();
    this.queue = new PlaybackQueue({
      synthesize: (envelopeStr, signal) => this.synthesizeEnvelope(envelopeStr, signal),
      sink: this.sink,
      prefetchDepth: 2,
      onPlayStart: (envelopeStr) => {
        const info = this.pendingInfo.get(envelopeStr);
        this.pendingInfo.delete(envelopeStr);
        if (info) {
          info.startedAtMs = Date.now();
          this.lastUsesSystemTts = info.engine === "system";
          this.options.onUtteranceStart?.(info);
        }
      },
      onStateChange: (state) => {
        if (state === "idle") {
          this.pendingInfo.clear();
        }
        this.options.onStateChange?.(state);
      },
      onError: (err, envelopeStr) => {
        this.pendingInfo.delete(envelopeStr);
        this.options.onError?.(err, envelopeStr);
      }
    });
  }
  get state() {
    return this.queue.state;
  }
  get usesSystemTts() {
    const settings = this.options.getSettings();
    if (this.queue.state === "playing") {
      return this.lastUsesSystemTts;
    }
    return settings.defaultVoice.engine === "system";
  }
  /**
   * Synthesize utterances without playing and merge WAV-capable output into one file.
   * Non-WAV engines (system text / MP3 providers) are skipped and reported.
   */
  async exportUtterances(utterances) {
    const wavChunks = [];
    let skipped = 0;
    const exportedKeys = [];
    for (const utterance of utterances) {
      const envelope = JSON.stringify({
        seq: ++this.seq,
        role: utterance.role,
        speaker: utterance.speaker,
        ...utterance.avatar ? { avatar: utterance.avatar } : {},
        text: utterance.text
      });
      exportedKeys.push(envelope);
      let result = null;
      try {
        result = await this.synthesizeEnvelope(envelope, new AbortController().signal);
      } catch {
        skipped += 1;
        continue;
      }
      if (!result || result.mime !== "audio/wav") {
        skipped += 1;
        continue;
      }
      wavChunks.push(result.audio);
    }
    for (const key of exportedKeys) {
      this.pendingInfo.delete(key);
    }
    const merged = mergeMonoPcm16WavChunks(wavChunks);
    if (!merged) {
      return {
        wav: null,
        sampleRate: 0,
        sentences: 0,
        skipped: skipped + wavChunks.length,
        reason: "no-wav-engine"
      };
    }
    return {
      wav: merged.wav,
      sampleRate: merged.sampleRate,
      sentences: merged.merged,
      skipped: skipped + merged.skipped
    };
  }
  enqueueUtterance(utterance) {
    const settings = this.options.getSettings();
    if (!settings.enabled) return false;
    const cardVoiceRaw = this.options.getCharacterCardVoice?.(
      utterance.speaker,
      utterance.avatar
    );
    const cardVoice = cardVoiceRaw && typeof cardVoiceRaw === "object" ? normalizeVoiceAssignment(cardVoiceRaw, settings.defaultVoice.engine) : void 0;
    const resolved = resolveUtteranceVoice(utterance, settings, cardVoice);
    this.lastUsesSystemTts = resolved.engine === "system";
    const envelope = {
      seq: ++this.seq,
      role: utterance.role,
      speaker: utterance.speaker,
      ...utterance.avatar ? { avatar: utterance.avatar } : {},
      text: utterance.text,
      ...cardVoice ? { cardVoice } : {}
    };
    return this.queue.enqueue(JSON.stringify(envelope));
  }
  cancel() {
    this.pendingInfo.clear();
    this.queue.cancel();
    this.sink.stop?.();
    this.daemonClient?.interruptTts();
  }
  waitUntilDrained() {
    return this.queue.waitUntilDrained();
  }
  async dispose() {
    this.pendingInfo.clear();
    this.queue.dispose();
    this.sink.stop?.();
    if (this.daemonClient) {
      await this.daemonClient.close();
      this.daemonClient = null;
    }
    await this.systemEngine.close();
  }
  getBoundFetch() {
    const custom = this.options.fetchImpl;
    if (custom) {
      return (input, init) => custom(input, init);
    }
    return (input, init) => globalThis.fetch(input, init);
  }
  async isServerPluginHealthy(baseFetch) {
    const now = Date.now();
    if (this.serverPluginState && now < this.serverPluginState.expiresAt) {
      return this.serverPluginState.available;
    }
    try {
      const res = await baseFetch("/api/plugins/voice-mode/health", {
        method: "GET",
        signal: AbortSignal.timeout(800)
      });
      if (!res.ok) {
        this.serverPluginState = {
          available: false,
          expiresAt: now + SERVER_PLUGIN_HEALTH_TTL_MS
        };
        return false;
      }
      const data = await res.json();
      const available = data?.ok === true && data?.id === "voice-mode";
      this.serverPluginState = {
        available,
        expiresAt: now + SERVER_PLUGIN_HEALTH_TTL_MS
      };
      return available;
    } catch {
      this.serverPluginState = {
        available: false,
        expiresAt: now + SERVER_PLUGIN_HEALTH_TTL_MS
      };
      return false;
    }
  }
  getOrCreateDaemonClient(settings) {
    if (this.daemonClient && this.daemonClientUrl === settings.daemonBaseUrl) {
      return this.daemonClient;
    }
    this.daemonClient = new DaemonClient({
      baseUrl: settings.daemonBaseUrl,
      token: () => this.options.getSecret("daemon"),
      probeTimeoutMs: DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
      fallbackTts: this.systemEngine,
      onFallback: (surface, reason) => {
        if (surface === "tts") {
          this.options.onDaemonFallback?.(reason);
        }
      },
      fetchImpl: this.getBoundFetch()
    });
    this.daemonClientUrl = settings.daemonBaseUrl;
    return this.daemonClient;
  }
  buildFetchForByok(settings, slot, presetId, customBaseUrl) {
    const baseFetch = this.getBoundFetch();
    if (!settings.useServerPluginProxy) {
      return baseFetch;
    }
    return async (input, init) => {
      const pluginReady = await this.isServerPluginHealthy(baseFetch);
      if (!pluginReady) {
        return baseFetch(input, init);
      }
      const stHeaders = this.options.getRequestHeaders?.() ?? {
        "Content-Type": "application/json"
      };
      return baseFetch("/api/plugins/voice-mode/tts", {
        method: "POST",
        headers: stHeaders,
        body: JSON.stringify({
          presetId,
          ...customBaseUrl ? { customBaseUrl } : {},
          secretSlot: slot,
          upstreamBody: init?.body ? String(init.body) : "{}"
        }),
        signal: init?.signal
      });
    };
  }
  async synthesizeEnvelope(envelopeStr, signal) {
    const parsed = JSON.parse(envelopeStr);
    const settings = this.options.getSettings();
    const assignment = resolveUtteranceVoice(
      parsed,
      settings,
      parsed.cardVoice
    );
    const planMode = assignment.engine === "openai-compat" || assignment.engine === "mimo" ? "instructions" : "pcm-segments";
    const plan = compileEmotionPlan(parsed.text, planMode);
    if (!plan.plainText.trim()) {
      return null;
    }
    this.pendingInfo.set(envelopeStr, {
      role: parsed.role,
      speaker: parsed.speaker,
      ...parsed.avatar ? { avatar: parsed.avatar } : {},
      engine: assignment.engine,
      voice: assignment.voice,
      rawText: parsed.text,
      plainText: plan.plainText,
      hasEmotionCues: plan.hasEmotionCues,
      startedAtMs: 0
    });
    if (assignment.engine === "system") {
      const sysSegments = buildSystemTtsSegments(parsed.text, plan.segments);
      return this.systemEngine.synthesize(plan.plainText, {
        voice: assignment.voice,
        rate: assignment.rate,
        signal,
        segments: sysSegments
      });
    }
    if (assignment.engine === "kokoro-daemon") {
      const client = this.getOrCreateDaemonClient(settings);
      const res = await client.synthesize(parsed.text, {
        voice: assignment.voice || void 0,
        rate: assignment.rate,
        signal
      });
      if (res.mime === SYSTEM_TTS_MIME) {
        const info = this.pendingInfo.get(envelopeStr);
        if (info) info.engine = "system";
      }
      return res;
    }
    if (assignment.engine === "mimo") {
      const engine2 = new MimoTtsEngine({
        baseUrl: settings.mimoBaseUrl,
        model: settings.mimoModel,
        voice: assignment.voice || void 0,
        apiKey: () => this.options.getSecret("mimo"),
        instructions: plan.instructions || void 0,
        fallback: () => this.systemEngine,
        fetchImpl: this.buildFetchForByok(settings, "mimo", "mimo")
      });
      return engine2.synthesize(plan.plainText, {
        voice: assignment.voice || void 0,
        rate: assignment.rate,
        signal
      });
    }
    const effectivePresetId = assignment.presetId ?? settings.openaiTtsPresetId;
    const engine = new OpenAiCompatTtsEngine({
      presetId: effectivePresetId,
      baseUrl: settings.openaiTtsBaseUrl,
      model: settings.openaiTtsModel,
      voice: assignment.voice || void 0,
      apiKey: () => this.options.getSecret("openaiTts"),
      instructions: plan.instructions || void 0,
      fallback: () => this.systemEngine,
      fetchImpl: this.buildFetchForByok(
        settings,
        "openaiTts",
        effectivePresetId,
        effectivePresetId === "custom" ? settings.openaiTtsBaseUrl : void 0
      )
    });
    return engine.synthesize(plan.plainText, {
      voice: assignment.voice || void 0,
      rate: assignment.rate,
      signal
    });
  }
};

// src/voice-io.ts
var SEMANTIC_END_RE = /[。！？!?.…]\s*$/;
function isSemanticEndpoint(text) {
  const trimmed = String(text).trim();
  return trimmed.length >= 4 && SEMANTIC_END_RE.test(trimmed);
}
var ENERGY_VAD_CONFIRM_CHUNKS = 5;
function computeZeroCrossingRate(samples) {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] >= 0 && samples[i] < 0 || samples[i - 1] < 0 && samples[i] >= 0) {
      crossings++;
    }
  }
  return crossings / (samples.length - 1);
}
function computeCrestFactor(samples, rms) {
  if (rms <= 0 || samples.length === 0) return Infinity;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak / rms;
}
function createEnergyVadWorkerClient(minSpeechRms = 0.015) {
  return new SherpaWorkerClient({
    createWorkerSource: () => "/* voice-mode energy+zcr+crest vad */",
    loadModelBinaries: async () => [],
    idleUnloadMs: 0,
    workerFactory: () => {
      let terminated = false;
      const worker = {
        onmessage: null,
        onerror: null,
        postMessage(raw) {
          if (terminated || !isWorkerRequest(raw)) return;
          const respond = (res) => {
            queueMicrotask(() => {
              if (!terminated) {
                worker.onmessage?.({ data: res });
              }
            });
          };
          if (raw.type === "model:load") {
            respond({
              id: raw.id,
              type: "model:loaded",
              target: raw.target,
              elapsedMs: 0
            });
            return;
          }
          if (raw.type === "vad:process") {
            const pcm = new Float32Array(raw.pcm);
            const rms = computeChunkRms(pcm);
            const zcr = computeZeroCrossingRate(pcm);
            const crest = computeCrestFactor(pcm, rms);
            const plausibleBand = zcr >= 8e-3 && zcr <= 0.42 && crest <= 10;
            const isSpeech = rms >= minSpeechRms && plausibleBand;
            const speechProbability = isSpeech ? Math.min(0.99, 0.55 + rms * 2) : Math.min(0.4, rms * 8);
            respond({
              id: raw.id,
              type: "vad:result",
              speechProbability,
              isSpeech,
              speechEnded: false
            });
            return;
          }
          respond({ id: raw.id, type: "worker:ack" });
        },
        terminate() {
          terminated = true;
        }
      };
      return { worker };
    }
  });
}
function webSpeechError(code, fallback) {
  if (code === "not-allowed" || code === "NotAllowedError") {
    return new DOMException(
      "Microphone access was denied. Allow microphone access in the site settings and try again, or type your message.",
      "NotAllowedError"
    );
  }
  if (code === "service-not-allowed") {
    return new DOMException(
      "The browser denied access to its speech recognition service. Select another ASR engine or type your message.",
      "ServiceNotAllowedError"
    );
  }
  return fallback ?? new Error(`SpeechRecognition error: ${code}`);
}
var VoiceModeIoController = class {
  options;
  vadWorkerClient;
  monitor;
  focusInjector = new FocusTextInjector();
  /** Shared duplex state machine (P3): playback/interrupt bookkeeping stays uniform. */
  duplex = new DuplexProtocol({ duckOnOverlap: false });
  cloudSession = null;
  daemonAsrClient = null;
  systemRecognition = null;
  dictationGeneration = 0;
  dictationState = "idle";
  bargeInCount = 0;
  ownsVadWorker;
  constructor(options) {
    this.options = options;
    this.ownsVadWorker = !options.sileroWorkerClient;
    this.vadWorkerClient = options.sileroWorkerClient ?? createEnergyVadWorkerClient();
    const win = options.getWindow();
    const ua = win && typeof win.navigator?.userAgent === "string" ? win.navigator.userAgent : "";
    const isEdge = /\bEdg\//.test(ua);
    const isSafari = /\bSafari\//.test(ua) && !/(?:Chrome|Chromium|HeadlessChrome|CriOS|Edg)\//.test(ua);
    const isMobile = /\bAndroid\b|\biPhone\b|\biPad\b/i.test(ua);
    this.monitor = new AecBargeInMonitor({
      workerClient: this.vadWorkerClient,
      captureAudio: options.bargeInCaptureAudio,
      confirmChunks: options.sileroWorkerClient ? 2 : ENERGY_VAD_CONFIRM_CHUNKS,
      isEdge,
      isSafari,
      isMobile,
      onBargeIn: (ev) => {
        this.triggerBargeIn("aec3", ev);
      },
      onError: (err) => {
        this.options.onError?.(err);
      }
    });
  }
  get totalBargeIns() {
    return this.bargeInCount;
  }
  get activeDictationState() {
    return this.dictationState;
  }
  checkSecureOrigin() {
    return inspectSecureOrigin(this.options.getWindow());
  }
  /**
   * Immediately cancel TTS audio queue AND abort active SillyTavern LLM generation
   * (strictly guarded by `isGenerating()` so idle controllers never emit spurious stops).
   */
  triggerBargeIn(source = "manual", event) {
    this.bargeInCount++;
    const transition = this.duplex.feed({ type: "barge-in" });
    const actions = new Set(transition.actions);
    void this.monitor.stop();
    if (actions.has("stop-playback")) {
      this.options.cancelPlayback();
    }
    if (actions.has("cancel-generation") && this.options.isGenerating()) {
      this.options.stopGeneration();
    }
    this.options.onBargeInTriggered?.(source, event);
  }
  async armBargeIn(overrides) {
    const settings = this.options.getSettings();
    const originStatus = this.checkSecureOrigin();
    if (!originStatus.secure) {
      this.options.onInsecureOrigin?.(originStatus);
      return {
        activePolicy: "manual",
        reason: "native-aec-inactive",
        aecProbe: null
      };
    }
    const started = await this.monitor.start({
      bargeInMode: settings.bargeInMode,
      usesSystemTts: overrides?.usesSystemTts ?? settings.defaultVoice.engine === "system"
    });
    if (started.activePolicy === "auto") {
      this.duplex.feed({ type: "playback-start" });
    }
    return started;
  }
  async disarmBargeIn() {
    await this.monitor.stop();
    this.duplex.feed({ type: "playback-end" });
  }
  /** Current duplex state (idle/listening/overlap/speaking/barge-in) for diagnostics. */
  get duplexState() {
    return this.duplex.snapshot().state;
  }
  injectDictatedText(rawText) {
    const settings = this.options.getSettings();
    const replacer = createAsrReplacer(settings.asrReplacements);
    const transformed = replacer(rawText).trim();
    if (!transformed) return "";
    const doc = this.options.getDocument();
    if (!doc) return transformed;
    const sendTextarea = doc.getElementById("send_textarea");
    if (sendTextarea && doc.activeElement !== sendTextarea) {
      sendTextarea.focus();
    }
    this.focusInjector.inject(doc, transformed);
    if (settings.autoSendOnDictation) {
      const sendBtn = doc.getElementById("send_but");
      sendBtn?.click();
    }
    return transformed;
  }
  async startDictation() {
    const originStatus = this.checkSecureOrigin();
    if (!originStatus.secure) {
      this.options.onInsecureOrigin?.(originStatus);
      return false;
    }
    const generation = ++this.dictationGeneration;
    await this.stopDictation();
    if (generation !== this.dictationGeneration) return false;
    this.triggerBargeIn("manual");
    const settings = this.options.getSettings();
    if (settings.asrEngine === "system") {
      return this.startBrowserSpeechRecognition(settings, generation);
    }
    const boundFetch = this.options.fetchImpl ? (input, init) => this.options.fetchImpl(input, init) : (input, init) => globalThis.fetch(input, init);
    const openaiAsr = new OpenAiCompatAsrTransport({
      baseUrl: settings.asrBaseUrl,
      model: settings.asrModel,
      language: settings.asrLanguage,
      apiKey: () => this.options.getSecret("asr"),
      fetchImpl: boundFetch
    });
    const transport = settings.asrEngine === "daemon" ? (this.daemonAsrClient = new DaemonClient({
      baseUrl: settings.daemonBaseUrl,
      token: () => this.options.getSecret("daemon"),
      probeTimeoutMs: DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
      language: settings.asrLanguage,
      fallbackAsr: openaiAsr,
      fetchImpl: boundFetch
    })).asr : openaiAsr;
    this.cloudSession = new CloudDictationSession({
      transport,
      captureAudio: this.options.dictationCaptureAudio,
      language: settings.asrLanguage,
      onStateChange: (state) => this.setDictationState(state),
      onFinalTranscript: (text) => {
        this.injectDictatedText(text);
      },
      onError: (err) => this.options.onError?.(err)
    });
    await this.cloudSession.start("single");
    return true;
  }
  async stopDictation() {
    const recognition = this.systemRecognition;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
      }
      if (this.systemRecognition === recognition) {
        this.systemRecognition = null;
        this.setDictationState("idle");
      }
    }
    if (this.cloudSession) {
      await this.cloudSession.stop();
      this.cloudSession = null;
    }
    if (this.daemonAsrClient) {
      await this.daemonAsrClient.close();
      this.daemonAsrClient = null;
    }
  }
  async dispose() {
    ++this.dictationGeneration;
    await this.stopDictation();
    await this.monitor.stop();
    if (this.ownsVadWorker) {
      await this.vadWorkerClient.dispose();
    }
  }
  setDictationState(state) {
    this.dictationState = state;
    this.options.onDictationStateChange?.(state);
  }
  startBrowserSpeechRecognition(settings, generation) {
    const win = this.options.getWindow();
    const Ctor = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
    if (typeof Ctor !== "function") {
      this.options.onError?.(
        new DOMException(
          "Browser SpeechRecognition is unavailable; select OpenAI-Compatible or Local Voice Daemon ASR.",
          "NotSupportedError"
        )
      );
      return false;
    }
    const rec = new Ctor();
    if (settings.asrLanguage && settings.asrLanguage !== "auto") {
      rec.lang = settings.asrLanguage;
    }
    rec.continuous = false;
    rec.interimResults = settings.semanticEndpoint;
    rec.onresult = (ev) => {
      if (generation !== this.dictationGeneration) return;
      const finals = [];
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        const top = res[0];
        const transcript = top?.transcript ?? "";
        if (!transcript) continue;
        if (res.isFinal !== false) {
          finals.push(transcript);
        } else {
          interim += transcript;
        }
      }
      const finalText = finals.join(" ").trim();
      if (finalText) {
        this.injectDictatedText(finalText);
        return;
      }
      if (settings.semanticEndpoint && interim && isSemanticEndpoint(interim)) {
        try {
          rec.stop();
        } catch {
        }
      }
    };
    const finish = (error) => {
      if (generation !== this.dictationGeneration) return;
      ++this.dictationGeneration;
      if (this.systemRecognition !== rec) return;
      this.systemRecognition = null;
      this.setDictationState("idle");
      if (error !== void 0) {
        rec.onresult = null;
        this.options.onError?.(error);
      }
    };
    rec.onerror = ({ error }) => {
      if (error && error !== "no-speech" && error !== "aborted") {
        finish(webSpeechError(error));
      }
    };
    rec.onend = () => finish();
    this.systemRecognition = rec;
    this.setDictationState("listening");
    try {
      rec.start();
      return true;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      finish(webSpeechError(name, error));
      return false;
    }
  }
};

// src/settings-drawer.ts
function makeEl(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
}
function buildSettingsDrawer(doc, hostContainer, options) {
  const { text, getSettings, updateSettings, resolveActiveSpeaker, originStatus } = options;
  const settings = getSettings();
  const root = makeEl(doc, "div", "inline-drawer vm-st-drawer");
  root.id = "voice_mode_settings_drawer";
  const header = makeEl(doc, "div", "inline-drawer-toggle inline-drawer-header");
  const title = makeEl(doc, "b", void 0, text("title", "Voice Mode"));
  const statusBadgeEl = makeEl(doc, "span", "vm-st-status-badge", text("ready", "Ready"));
  statusBadgeEl.setAttribute("role", "status");
  const icon = makeEl(doc, "div", "inline-drawer-icon fa-solid fa-circle-chevron-down down");
  header.append(title, statusBadgeEl, icon);
  const content = makeEl(doc, "div", "inline-drawer-content vm-st-settings");
  const insecureBannerEl = makeEl(
    doc,
    "div",
    "vm-st-insecure-banner"
  );
  insecureBannerEl.dataset.vmInsecureBanner = "true";
  const showOriginStatus = (status) => {
    insecureBannerEl.hidden = status.secure;
    insecureBannerEl.textContent = status.secure ? "" : text("insecure_origin", "{0}", status.remediation, status.originLabel);
  };
  showOriginStatus(originStatus);
  content.appendChild(insecureBannerEl);
  const addCheckbox = (id, labelText, checked, onChange) => {
    const row = makeEl(doc, "label", "checkbox_label vm-st-row");
    const input = makeEl(doc, "input");
    input.type = "checkbox";
    input.id = id;
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    row.append(input, makeEl(doc, "span", void 0, labelText));
    content.appendChild(row);
  };
  addCheckbox("vm_st_enabled", text("enabled", "Enable Streaming Voice Mode"), settings.enabled, (v) => {
    updateSettings((d) => {
      d.enabled = v;
    });
    if (!v) options.triggerBargeIn();
  });
  addCheckbox(
    "vm_st_narration_split",
    text("narration_split", "Separate *Narration* and Dialogue Voices"),
    settings.narrationSplitEnabled,
    (v) => updateSettings((d) => void (d.narrationSplitEnabled = v))
  );
  addCheckbox(
    "vm_st_emotion_prompt",
    text("emotion_prompt", "Inject Emotion Cue System Prompt (<whisper>, <break>)"),
    settings.emotionPromptEnabled,
    (v) => updateSettings((d) => void (d.emotionPromptEnabled = v))
  );
  addCheckbox(
    "vm_st_auto_send",
    text("auto_send", "Auto-Send Message After Voice Dictation"),
    settings.autoSendOnDictation,
    (v) => updateSettings((d) => void (d.autoSendOnDictation = v))
  );
  addCheckbox(
    "vm_st_semantic_endpoint",
    text("semantic_endpoint", "Stop Dictation When the Sentence Is Complete (Browser ASR)"),
    settings.semanticEndpoint,
    (v) => updateSettings((d) => void (d.semanticEndpoint = v))
  );
  addCheckbox(
    "vm_st_use_server_proxy",
    text("server_proxy", "Route Cloud TTS via Optional Server Plugin Proxy (/api/plugins/voice-mode)"),
    settings.useServerPluginProxy,
    (v) => updateSettings((d) => void (d.useServerPluginProxy = v))
  );
  const datalist = makeEl(doc, "datalist");
  datalist.id = "vm_st_kokoro_voices";
  for (const preset of KOKORO_DEFAULT_SPEAKERS) {
    const opt = makeEl(doc, "option");
    opt.value = preset.id;
    opt.textContent = `${preset.label} (${preset.lang})`;
    datalist.appendChild(opt);
  }
  content.appendChild(datalist);
  const makeSelect = (id, items, initial, onChange) => {
    const sel = makeEl(doc, "select", "text_pole");
    sel.id = id;
    for (const [val, label] of items) {
      const opt = makeEl(doc, "option", void 0, label);
      opt.value = val;
      opt.selected = val === initial;
      sel.appendChild(opt);
    }
    if (onChange) sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };
  const makeInput = (id, type, placeholder, initial = "") => {
    const inp = makeEl(doc, "input", "text_pole");
    inp.type = type;
    inp.id = id;
    inp.placeholder = placeholder;
    inp.value = initial;
    return inp;
  };
  const ENGINE_OPTIONS = [
    ["system", text("tts_system", "Browser System TTS (Zero Config)")],
    ["kokoro-daemon", text("tts_kokoro", "Local Kokoro Daemon (103 Voices)")],
    ["openai-compat", text("tts_openai", "OpenAI-Compatible BYOK TTS")],
    ["mimo", text("tts_mimo", "Xiaomi MiMo TTS")]
  ];
  const buildVoiceRow = (prefix, heading, currentEngine, currentVoice, onUpdate) => {
    const wrap = makeEl(doc, "div", "vm-st-field-group");
    wrap.appendChild(makeEl(doc, "label", void 0, heading));
    const select = makeSelect(`${prefix}_engine`, ENGINE_OPTIONS, currentEngine);
    const voiceInput = makeInput(
      `${prefix}_voice`,
      "text",
      text("voice_id", "Voice ID (zf_001, alloy, default)"),
      currentVoice
    );
    voiceInput.setAttribute("list", "vm_st_kokoro_voices");
    const commit = () => onUpdate(select.value, voiceInput.value.trim());
    select.addEventListener("change", commit);
    voiceInput.addEventListener("change", commit);
    wrap.append(select, voiceInput);
    content.appendChild(wrap);
  };
  buildVoiceRow(
    "vm_st_default",
    text("default_voice", "Default Character Voice"),
    settings.defaultVoice.engine,
    settings.defaultVoice.voice,
    (engine, voice) => updateSettings((d) => {
      d.defaultVoice = { engine, voice };
    })
  );
  buildVoiceRow(
    "vm_st_narrator",
    text("narrator_voice", "Narrator Voice (*action*)"),
    settings.narratorVoice.engine,
    settings.narratorVoice.voice,
    (engine, voice) => updateSettings((d) => {
      d.narratorVoice = { engine, voice };
    })
  );
  const charWrap = makeEl(doc, "div", "vm-st-field-group");
  charWrap.id = "vm_st_char_voice_section";
  const charLabel = makeEl(doc, "label");
  charLabel.id = "vm_st_active_char_label";
  const charEngineSelect = makeSelect(
    "vm_st_char_engine",
    [["", text("inherit_voice", "Inherit Default Character Voice")], ...ENGINE_OPTIONS],
    ""
  );
  const charVoiceInput = makeInput(
    "vm_st_char_voice",
    "text",
    text("character_voice_override", "Character Voice ID override")
  );
  charVoiceInput.setAttribute("list", "vm_st_kokoro_voices");
  const charResetBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("reset_voice", "Reset Character Voice")
  );
  charResetBtn.type = "button";
  charResetBtn.id = "vm_st_char_reset_btn";
  const activeVoiceKey = () => {
    const { speaker, avatar } = resolveActiveSpeaker();
    return { key: avatar || speaker, label: speaker || avatar || text("no_character", "(None)") };
  };
  const refreshCharacter = () => {
    const { key, label } = activeVoiceKey();
    const entry = key ? getSettings().voiceMap[key] : void 0;
    charLabel.textContent = text("active_voice", "Active Character Voice: {0}", label);
    charEngineSelect.value = entry ? entry.engine : "";
    charVoiceInput.value = entry ? entry.voice : "";
    charEngineSelect.disabled = charVoiceInput.disabled = charResetBtn.disabled = !key;
  };
  const commitCharOverride = () => {
    const { key } = activeVoiceKey();
    if (!key) return;
    const eng = charEngineSelect.value;
    const v = charVoiceInput.value.trim();
    updateSettings((d) => {
      if (!eng && !v) delete d.voiceMap[key];
      else d.voiceMap[key] = { engine: eng || d.defaultVoice.engine, voice: v };
    });
    refreshCharacter();
  };
  charEngineSelect.addEventListener("change", commitCharOverride);
  charVoiceInput.addEventListener("change", commitCharOverride);
  charResetBtn.addEventListener("click", () => {
    const { key } = activeVoiceKey();
    if (key) updateSettings((d) => void delete d.voiceMap[key]);
    refreshCharacter();
  });
  charWrap.append(charLabel, charEngineSelect, charVoiceInput, charResetBtn);
  content.appendChild(charWrap);
  refreshCharacter();
  const endpointsWrap = makeEl(doc, "div", "vm-st-field-group");
  endpointsWrap.appendChild(makeEl(doc, "label", void 0, text("endpoints", "Endpoint Base URLs")));
  for (const [id, ph, key] of [
    ["vm_st_openai_tts_base_url", text("openai_tts_url", "OpenAI TTS URL"), "openaiTtsBaseUrl"],
    ["vm_st_asr_base_url", text("openai_asr_url", "OpenAI ASR URL"), "asrBaseUrl"],
    ["vm_st_daemon_base_url", text("daemon_url", "Local Daemon URL"), "daemonBaseUrl"]
  ]) {
    const inp = makeInput(id, "url", ph, settings[key]);
    inp.addEventListener("change", () => {
      updateSettings((d) => {
        d[key] = inp.value.trim();
      });
      inp.value = getSettings()[key];
    });
    const label = makeEl(doc, "label", void 0, ph);
    label.htmlFor = id;
    endpointsWrap.append(label, inp);
  }
  content.appendChild(endpointsWrap);
  const bargeWrap = makeEl(doc, "div", "vm-st-field-group");
  bargeWrap.appendChild(makeEl(doc, "label", void 0, text("barge_and_asr", "Voice Barge-In & ASR Engine")));
  const bargeSelect = makeSelect(
    "vm_st_barge_mode",
    [
      ["detect", text("barge_detect", "AEC3 Auto-Detect (Safe Default)")],
      ["auto", text("barge_auto", "Force Hands-Free Barge-In")],
      ["manual", text("barge_manual", "Manual Button / Hotkey Only")]
    ],
    settings.bargeInMode,
    (v) => updateSettings((d) => void (d.bargeInMode = v))
  );
  const asrSelect = makeSelect(
    "vm_st_asr_engine",
    [
      ["system", text("asr_system", "Browser SpeechRecognition ASR")],
      ["daemon", text("asr_daemon", "Local Voice Daemon ASR")],
      ["openai-compat", text("asr_openai", "OpenAI-Compatible Whisper ASR")]
    ],
    settings.asrEngine,
    (v) => updateSettings((d) => void (d.asrEngine = v))
  );
  bargeSelect.setAttribute("aria-label", text("barge_mode", "Voice Barge-In mode"));
  asrSelect.setAttribute("aria-label", text("asr_engine", "ASR engine"));
  bargeWrap.append(bargeSelect, asrSelect);
  content.appendChild(bargeWrap);
  const secretWrap = makeEl(doc, "div", "vm-st-field-group");
  secretWrap.appendChild(makeEl(doc, "label", void 0, text("secrets", "Server Secrets (/api/secrets/write)")));
  const slotSelect = makeSelect(
    "vm_st_secret_slot",
    [
      ["openaiTts", text("secret_openai", "OpenAI-Compatible TTS Key")],
      ["mimo", text("secret_mimo", "MiMo TTS Key")],
      ["asr", text("secret_asr", "OpenAI-Compatible ASR Key")],
      ["daemon", text("secret_daemon", "Local Voice Daemon Token")]
    ],
    "openaiTts"
  );
  const secretInput = makeInput("vm_st_secret_input", "password", text("paste_secret", "Paste secret key"));
  secretInput.autocomplete = "off";
  const saveKeyBtn = makeEl(doc, "button", "menu_button", text("save_secret", "Save Server Secret"));
  saveKeyBtn.type = "button";
  saveKeyBtn.id = "vm_st_save_secret_btn";
  saveKeyBtn.addEventListener("click", () => {
    const slot = slotSelect.value;
    const value = secretInput.value;
    secretInput.value = "";
    saveKeyBtn.disabled = true;
    void options.saveSecret(slot, value).finally(() => {
      saveKeyBtn.disabled = false;
    });
  });
  secretWrap.append(slotSelect, secretInput, saveKeyBtn);
  content.appendChild(secretWrap);
  const actions = makeEl(doc, "div", "vm-st-actions");
  const dictateBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("dictate", "Dictate Mic")
  );
  dictateBtn.type = "button";
  dictateBtn.id = "vm_st_dictate_btn";
  dictateBtn.disabled = !originStatus.secure;
  dictateBtn.addEventListener("click", options.toggleDictation);
  const bargeBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("barge", "Stop / Barge-In")
  );
  bargeBtn.type = "button";
  bargeBtn.id = "vm_st_barge_in_btn";
  bargeBtn.addEventListener("click", options.triggerBargeIn);
  let exportInProgress = false;
  const runExport = (start, fileName) => {
    if (exportInProgress) return;
    exportInProgress = true;
    void (async () => {
      statusBadgeEl.textContent = text("exporting", "Exporting\u2026");
      try {
        const result = await start();
        if (!result.wav) {
          statusBadgeEl.textContent = result.reason === "empty" ? text("export_empty", "No reply to export.") : text(
            "export_no_wav",
            "Current TTS engine cannot export WAV; the local voice-daemon or a WAV-capable engine is required."
          );
          return;
        }
        try {
          const wavBuffer = result.wav.buffer.slice(
            result.wav.byteOffset,
            result.wav.byteOffset + result.wav.byteLength
          );
          const url = URL.createObjectURL(new Blob([wavBuffer], { type: "audio/wav" }));
          const link = doc.createElement("a");
          link.href = url;
          link.download = `${fileName}-${Date.now()}.wav`;
          link.click();
          URL.revokeObjectURL(url);
        } catch {
        }
        statusBadgeEl.textContent = text("export_done", "Exported {0} sentences to WAV.", String(result.sentences));
      } catch {
        statusBadgeEl.textContent = text("export_failed", "Export failed. Check the console and retry.");
      } finally {
        exportInProgress = false;
      }
    })();
  };
  const makeExportButton = (id, label, action, fileName) => {
    const btn = makeEl(doc, "button", "menu_button", label);
    btn.type = "button";
    btn.id = id;
    btn.addEventListener("click", () => runExport(action, fileName));
    return btn;
  };
  const exportBtn = makeExportButton(
    "vm_st_export_wav_btn",
    text("export_wav", "Export last reply as WAV"),
    options.exportLastReplyAsWav,
    "voice-mode"
  );
  const exportChatBtn = makeExportButton(
    "vm_st_export_chat_btn",
    text("export_chat", "Export last 10 replies as WAV"),
    options.exportRecentRepliesAsWav,
    "voice-mode-chat"
  );
  const diagBtn = makeEl(
    doc,
    "button",
    "menu_button",
    text("copy_diagnostics", "Copy diagnostics")
  );
  diagBtn.type = "button";
  diagBtn.id = "vm_st_copy_diagnostics_btn";
  diagBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const payload = JSON.stringify(options.getDiagnostics(), null, 2);
        const nav = doc.defaultView?.navigator;
        const clipboard = nav?.clipboard;
        if (!clipboard?.writeText) throw new Error("clipboard unavailable");
        await clipboard.writeText(payload);
        statusBadgeEl.textContent = text("diagnostics_copied", "Diagnostics copied to clipboard.");
      } catch {
        statusBadgeEl.textContent = text(
          "diagnostics_copy_failed",
          "Could not copy diagnostics (clipboard unavailable)."
        );
      }
    })();
  });
  actions.append(dictateBtn, bargeBtn, exportBtn, exportChatBtn, diagBtn);
  content.appendChild(actions);
  root.append(header, content);
  hostContainer.appendChild(root);
  return {
    root,
    refreshCharacter,
    showOriginStatus,
    setStatus(message) {
      statusBadgeEl.textContent = message;
    },
    setDictationState(state) {
      dictateBtn.textContent = state === "idle" ? text("dictate", "Dictate Mic") : text("stop_dictation", "Stop Dictation");
    }
  };
}

// src/ui-text.ts
function createUiText(translate2) {
  return (key, fallback, ...values) => {
    const message = translate2?.(fallback, `voice_mode.${key}`) || fallback;
    if (!values.length) return message;
    return message.replace(
      /\{(\d+)\}/g,
      (placeholder, index) => values[Number(index)] ?? placeholder
    );
  };
}

// src/runtime.ts
function createVoiceModeRuntime(host) {
  let activated = false;
  let emotionPromptRegistered = false;
  let inFlightGenerationEvent = false;
  let turnFirstPlayStartMs = 0;
  let turnEndedMs = 0;
  let firstSentenceLeadMs = 0;
  let lastDaemonFallbackReason = "";
  let lastError = "";
  const utteranceHistory = [];
  const cleanups = [];
  const getWin = () => host.getWindow ? host.getWindow() : typeof window !== "undefined" ? window : null;
  const getDoc = () => host.getDocument ? host.getDocument() : typeof document !== "undefined" ? document : null;
  const secretBroker = new SillyTavernSecretBroker(host.secrets);
  const getSettings = () => ensureExtensionSettings(host.extensionSettings);
  const isHostGenerating = () => {
    if (host.isGenerating() || inFlightGenerationEvent) return true;
    try {
      const sp = host.getContext().streamingProcessor;
      return Boolean(sp && !sp.isFinished && !sp.isStopped);
    } catch {
      return false;
    }
  };
  const resolveActiveSpeaker = () => {
    try {
      const ctx = host.getContext();
      const ch = typeof ctx.characterId === "number" ? ctx.characters[ctx.characterId] : void 0;
      if (ch) {
        return {
          speaker: ch.name || ctx.name2 || "",
          avatar: ch.avatar
        };
      }
      if (typeof ctx.groupId === "string" && ctx.groupId.length > 0) {
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const last = chat[chat.length - 1];
        if (last && !last.is_user && !last.is_system) {
          const name = typeof last.name === "string" ? last.name : "";
          const avatar = typeof last.original_avatar === "string" ? last.original_avatar : void 0;
          const matched = name ? ctx.characters.find((c) => c.name === name) : void 0;
          return {
            speaker: matched?.name ?? name ?? ctx.name2 ?? "",
            avatar: avatar ?? matched?.avatar
          };
        }
      }
      return { speaker: ctx.name2 || "" };
    } catch {
      return { speaker: "" };
    }
  };
  const getCharacterCardVoice = (speaker, avatar) => {
    try {
      const ctx = host.getContext();
      const found = ctx.characters.find(
        (c) => avatar && c.avatar === avatar || speaker && c.name === speaker
      );
      return found?.data?.extensions?.voice_mode;
    } catch {
      return void 0;
    }
  };
  const text = createUiText(host.translate);
  let drawer;
  const refreshStatusText = (message) => drawer?.setStatus(message);
  const showMicError = (err) => {
    lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
    let key = "mic_error";
    switch (err instanceof Error ? err.name : "") {
      case "NotAllowedError":
        key = "mic_permission";
        break;
      case "ServiceNotAllowedError":
        key = "mic_service";
        break;
      case "NotSupportedError":
        key = "mic_unsupported";
    }
    refreshStatusText(text(key, "Mic: {0}", lastError));
  };
  const ttsHub = new VoiceModeTtsHub({
    getSettings,
    getSecret: (slot) => secretBroker.getSecret(slot),
    getCharacterCardVoice,
    getRequestHeaders: () => host.getRequestHeaders(),
    fetchImpl: host.fetchImpl,
    sink: host.sink,
    onUtteranceStart: (info) => {
      if (turnFirstPlayStartMs === 0) {
        turnFirstPlayStartMs = info.startedAtMs;
      }
      utteranceHistory.push(info);
      if (utteranceHistory.length > 50) utteranceHistory.shift();
      const role = text(info.role, info.role);
      refreshStatusText(text("speaking", "Speaking ({0}: {1})", role, info.voice || info.engine));
    },
    onStateChange: (state) => {
      if (state === "playing") {
        const s = getSettings();
        if (s.bargeInMode !== "manual" && !ttsHub.usesSystemTts) {
          void io.armBargeIn({ usesSystemTts: false }).catch((err) => {
            lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
          });
        }
      } else if (state === "idle" && !isHostGenerating()) {
        void io.disarmBargeIn();
        refreshStatusText(text("ready", "Ready"));
      }
    },
    onDaemonFallback: (reason) => {
      lastDaemonFallbackReason = formatSafeError(
        reason,
        secretBroker.knownSecretsSnapshot()
      );
      refreshStatusText(text("daemon_fallback", "Daemon offline -> System TTS fallback (voice may change)"));
    },
    onError: (err) => {
      lastError = formatSafeError(err, secretBroker.knownSecretsSnapshot());
      refreshStatusText(text("tts_error", "Error: {0}", lastError));
    }
  });
  const router = new StreamingUtteranceRouter({
    narrationSplitEnabled: getSettings().narrationSplitEnabled,
    resolveActiveSpeaker,
    onUtterance: (utterance) => {
      ttsHub.enqueueUtterance(utterance);
    }
  });
  const io = new VoiceModeIoController({
    getSettings,
    getSecret: (slot) => secretBroker.getSecret(slot),
    getWindow: getWin,
    getDocument: getDoc,
    isGenerating: isHostGenerating,
    stopGeneration: () => host.stopGeneration(),
    cancelPlayback: () => {
      router.reset();
      ttsHub.cancel();
    },
    fetchImpl: host.fetchImpl,
    onInsecureOrigin: (status) => drawer?.showOriginStatus(status),
    onDictationStateChange: (state) => {
      drawer?.setDictationState(state);
      refreshStatusText(state === "idle" ? text("ready", "Ready") : text(`mic_${state}`, "Mic: {0}", state));
    },
    onError: showMicError
  });
  const syncEmotionPrompt = () => {
    const s = getSettings();
    const active = s.enabled && s.emotionPromptEnabled;
    const promptValue = active ? buildEmotionPromptInstruction({ allowRoleplayNarration: true }) : "";
    host.setExtensionPrompt(
      EMOTION_PROMPT_KEY,
      promptValue,
      host.extensionPromptTypes.IN_CHAT,
      0,
      false,
      host.extensionPromptRoles.SYSTEM
    );
    emotionPromptRegistered = active;
  };
  const updateSettings = (mutator) => {
    const current = getSettings();
    mutator(current);
    const normalized = ensureExtensionSettings(host.extensionSettings);
    router.setNarrationSplitEnabled(normalized.narrationSplitEnabled);
    syncEmotionPrompt();
    host.saveSettingsDebounced();
    return normalized;
  };
  const subscribe = (eventName, fn, useMakeLast = false) => {
    if (!eventName) return;
    if (useMakeLast && typeof host.eventSource.makeLast === "function") {
      host.eventSource.makeLast(eventName, fn);
    } else {
      host.eventSource.on(eventName, fn);
    }
    cleanups.push(() => host.eventSource.removeListener(eventName, fn));
  };
  const toggleDictation = () => {
    if (io.activeDictationState !== "idle") {
      void io.stopDictation().catch(showMicError);
    } else {
      void io.startDictation().catch(showMicError);
    }
  };
  const collectRepliesForExport = (limit) => {
    const ctx = host.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const replies = [];
    for (let i = chat.length - 1; i >= 0 && replies.length < limit; i--) {
      const message = chat[i];
      if (!message || message.is_user === true) continue;
      const mes = typeof message.mes === "string" ? message.mes.trim() : "";
      if (!mes) continue;
      replies.push({ mes, name: typeof message.name === "string" ? message.name : void 0 });
    }
    return replies.reverse();
  };
  const exportRepliesAsWav = async (limit) => {
    const replies = collectRepliesForExport(limit);
    if (replies.length === 0) {
      return { sentences: 0, skipped: 0, reason: "empty", wav: null };
    }
    const utterances = [];
    for (const reply of replies) {
      const speaker = reply.name || resolveActiveSpeaker().speaker;
      const segmenter = new SentenceSegmenter({ maxSentenceChars: 200 });
      const sentences = [...segmenter.feed(reply.mes), ...segmenter.flush()].map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
      for (const text2 of sentences) {
        utterances.push({ role: "character", speaker, text: text2 });
      }
    }
    return ttsHub.exportUtterances(utterances);
  };
  const exportLastReplyAsWav = () => exportRepliesAsWav(1);
  const exportRecentRepliesAsWav = () => exportRepliesAsWav(10);
  const mountSettingsDrawer = (explicitDoc) => {
    const doc = explicitDoc ?? getDoc();
    if (!doc) return null;
    const existing = doc.getElementById("voice_mode_settings_drawer");
    if (existing) return existing;
    const hostContainer = doc.getElementById("extensions_settings") ?? doc.getElementById("extensions_settings2");
    if (!hostContainer) return null;
    drawer = buildSettingsDrawer(doc, hostContainer, {
      text,
      getSettings,
      updateSettings,
      resolveActiveSpeaker,
      originStatus: io.checkSecureOrigin(),
      triggerBargeIn: () => io.triggerBargeIn("manual"),
      async saveSecret(slot, value) {
        try {
          await secretBroker.setSecret(slot, value);
          refreshStatusText(value.trim() ? text("secret_saved", "Server secret saved.") : text("secret_deleted", "Server secret cleared."));
        } catch (err) {
          lastError = formatSafeError(err, [...secretBroker.knownSecretsSnapshot(), value.trim()]);
          refreshStatusText(text("secret_failed", "Could not update the server secret. Check SillyTavern and try again."));
        }
      },
      toggleDictation,
      exportLastReplyAsWav,
      exportRecentRepliesAsWav,
      getDiagnostics: collectDiagnostics
    });
    return drawer.root;
  };
  const collectDiagnostics = () => ({
    activated,
    emotionPromptRegistered,
    firstSentenceLeadMs,
    lastFirstUtteranceAtMs: turnFirstPlayStartMs,
    lastGenerationEndedAtMs: turnEndedMs,
    totalBargeIns: io.totalBargeIns,
    lastDaemonFallbackReason,
    lastError,
    secureOrigin: io.checkSecureOrigin(),
    utteranceHistory: utteranceHistory.slice(-10)
  });
  return {
    async activate() {
      if (activated) return;
      activated = true;
      const initial = getSettings();
      router.setNarrationSplitEnabled(initial.narrationSplitEnabled);
      syncEmotionPrompt();
      mountSettingsDrawer();
      const et = host.eventTypes;
      subscribe(et.APP_READY, () => {
        mountSettingsDrawer();
      });
      subscribe(et.GENERATION_STARTED, (type, _opts, dryRun) => {
        const genType = typeof type === "string" ? type : "normal";
        const isIgnored = dryRun === true || genType === "quiet" || genType === "impersonate";
        inFlightGenerationEvent = !isIgnored;
        turnFirstPlayStartMs = 0;
        turnEndedMs = 0;
        firstSentenceLeadMs = 0;
        const active = resolveActiveSpeaker();
        router.onGenerationStarted({
          type: genType,
          dryRun: dryRun === true,
          speaker: active.speaker,
          avatar: active.avatar
        });
      });
      subscribe(et.STREAM_TOKEN_RECEIVED, (cumulativeText) => {
        if (!getSettings().enabled) return;
        router.onStreamToken(typeof cumulativeText === "string" ? cumulativeText : "");
      });
      subscribe(et.GENERATION_ENDED, () => {
        inFlightGenerationEvent = false;
        turnEndedMs = Date.now();
        if (turnFirstPlayStartMs > 0 && turnEndedMs >= turnFirstPlayStartMs) {
          firstSentenceLeadMs = turnEndedMs - turnFirstPlayStartMs;
        }
        if (getSettings().enabled) {
          router.onGenerationEnded();
        } else {
          router.reset();
        }
      });
      subscribe(et.GENERATION_STOPPED, () => {
        inFlightGenerationEvent = false;
        router.onGenerationStopped();
        ttsHub.cancel();
        void io.disarmBargeIn();
      });
      subscribe(
        et.CHARACTER_MESSAGE_RENDERED,
        (messageId, type) => {
          if (!getSettings().enabled) return;
          const idx = typeof messageId === "number" ? messageId : -1;
          const ctx = host.getContext();
          const msg = idx >= 0 ? ctx.chat[idx] : void 0;
          router.onCharacterMessageRendered({
            messageId: idx,
            type: typeof type === "string" ? type : void 0,
            message: msg
          });
        },
        true
      );
      const resetAll = () => {
        inFlightGenerationEvent = false;
        router.onChatChanged();
        ttsHub.cancel();
        void io.disarmBargeIn();
        drawer?.refreshCharacter();
      };
      subscribe(et.CHAT_CHANGED, resetAll);
      subscribe(et.GROUP_UPDATED, () => drawer?.refreshCharacter());
      subscribe(et.MESSAGE_SWIPED, resetAll);
      subscribe(et.MESSAGE_DELETED, resetAll);
      const doc = getDoc();
      if (doc) {
        const onKeyDown = (ev) => {
          if (ev.altKey && ev.shiftKey && ev.code === "KeyB") {
            ev.preventDefault();
            io.triggerBargeIn("manual");
          } else if (ev.altKey && ev.shiftKey && ev.code === "KeyV") {
            ev.preventDefault();
            toggleDictation();
          }
        };
        doc.addEventListener("keydown", onKeyDown);
        cleanups.push(() => doc.removeEventListener("keydown", onKeyDown));
      }
      host.saveSettingsDebounced();
    },
    async dispose() {
      for (const fn of cleanups.splice(0)) {
        fn();
      }
      router.reset();
      await io.dispose();
      await ttsHub.dispose();
      activated = false;
    },
    getSettings,
    updateSettings,
    setSecret: (slot, value) => secretBroker.setSecret(slot, value),
    syncEmotionPrompt,
    triggerBargeIn: (source = "manual") => io.triggerBargeIn(source),
    startDictation: () => io.startDictation(),
    stopDictation: () => io.stopDictation(),
    mountSettingsDrawer,
    waitUntilIdle: () => ttsHub.waitUntilDrained(),
    getDiagnostics() {
      return collectDiagnostics();
    }
  };
}

// src/index.ts
var activeRuntime = null;
function getVoiceModeRuntime() {
  return activeRuntime;
}
async function activate() {
  if (!activeRuntime) {
    activeRuntime = createVoiceModeRuntime({
      eventSource,
      eventTypes: event_types,
      extensionPromptTypes: extension_prompt_types,
      extensionPromptRoles: extension_prompt_roles,
      extensionSettings: extension_settings,
      getContext,
      saveSettingsDebounced,
      isGenerating,
      stopGeneration,
      setExtensionPrompt,
      getRequestHeaders,
      translate,
      secrets: {
        writeSecret: (key, value, label) => writeSecret(key, value, label),
        findSecret: (key) => findSecret(key),
        deleteSecret: (key) => deleteSecret(key),
        canViewSecrets: () => canViewSecrets(),
        hasRemoteSecret: (key) => {
          const val = secret_state[key];
          return Array.isArray(val) ? val.length > 0 : Boolean(val);
        }
      }
    });
  }
  await activeRuntime.activate();
}
export {
  DEFAULT_SETTINGS,
  EMOTION_PROMPT_KEY,
  EXTENSION_KEY,
  EXTENSION_VERSION,
  activate,
  ensureExtensionSettings,
  getVoiceModeRuntime
};
