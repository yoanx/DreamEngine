#!/usr/bin/env node
/* ============================================================
 * es3check —— ExtendScript ES3 合规静态检查
 *
 * 用途：本项目无 AE 环境时无法运行 .jsx，靠本工具在提交前拦住 ES5+ 语法。
 * 依据：交接包 README §5「ExtendScript 是 ES3，没有 let/const、箭头函数、
 *       Promise，也不要用 JSON.parse」。
 *
 * 检查范围：仅 .jsx（跑在 ExtendScript 引擎）。
 *   .js 文件跑在 CEF/浏览器里，可用 ES5+/JSON.stringify，**不在检查范围**。
 *   注意 bridge.js 内嵌的 jsx 字符串会被 evalScript 送进 ExtendScript，
 *   那部分需人工确认（本工具在末尾单独提示）。
 *
 * 输出：违规项报 文件:行:列 + 片段；有 ERROR 时退出码 1。
 * 零依赖，只用 Node 内置模块。
 *
 * 用法：
 *   node tools/es3check.mjs            # 检查仓库内全部 .jsx
 *   node tools/es3check.mjs a.jsx b.jsx
 * ============================================================ */

import { readFileSync } from "node:fs";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- 规则表 ----------
 * level: "error" = ES3 下必然语法错误或运行时不存在，必须改
 *        "warn"  = 静态无法判定接收者类型，可能合法（如 String.indexOf 是 ES3 的）
 */
const RULES = [
  {
    id: "let-const",
    level: "error",
    re: /(?<![.\w$])(let|const)\s+[A-Za-z_$][\w$]*/g,
    msg: "ES3 无 let/const，改用 var",
  },
  {
    id: "arrow-fn",
    level: "error",
    re: /=>/g,
    msg: "ES3 无箭头函数，改用 function",
  },
  {
    id: "template-literal",
    level: "error",
    re: /`/g,
    msg: "ES3 无模板字符串，改用单/双引号拼接",
  },
  {
    id: "json-api",
    level: "error",
    re: /(?<![.\w$])JSON\s*\.\s*(parse|stringify)\b/g,
    msg: "ExtendScript 无内置 JSON（需引 json2.js），改用手工拼字符串",
  },
  {
    id: "class",
    level: "error",
    re: /(?<![.\w$])class\s+[A-Za-z_$]/g,
    msg: "ES3 无 class，改用构造函数 + prototype",
  },
  {
    id: "async-await",
    level: "error",
    re: /(?<![.\w$])(async\s+function|await\s+[\w$(])/g,
    msg: "ES3 无 async/await",
  },
  {
    id: "promise",
    level: "error",
    re: /(?<![.\w$])Promise\b/g,
    msg: "ES3 无 Promise，改用回调",
  },
  {
    id: "spread-rest",
    level: "error",
    re: /\.\.\./g,
    msg: "ES3 无展开/剩余运算符",
  },
  {
    id: "for-of",
    level: "error",
    re: /for\s*\(\s*(?:let|const|var)?\s*[A-Za-z_$][\w$]*\s+of\s/g,
    msg: "ES3 无 for...of，改用 for(var i=0;...)",
  },
  {
    id: "es5-object-statics",
    level: "error",
    re: /(?<![.\w$])Object\s*\.\s*(keys|create|defineProperty|getPrototypeOf|freeze|assign)\b/g,
    msg: "ES3 无该 Object 静态方法，改用 for...in + hasOwnProperty",
  },
  {
    id: "array-isarray",
    level: "error",
    re: /(?<![.\w$])Array\s*\.\s*isArray\b/g,
    msg: "ES3 无 Array.isArray，改用 instanceof Array",
  },
  {
    id: "map-set",
    level: "error",
    re: /new\s+(Map|Set|WeakMap|WeakSet)\s*\(/g,
    msg: "ES3 无 Map/Set，改用普通对象",
  },
  {
    id: "trailing-comma",
    level: "warn",
    re: /,\s*[\]}]/g,
    msg: "尾逗号在 ES3 下会造数组空洞或语法错误，建议去掉",
  },
  {
    id: "reserved-object-key",
    level: "error",
    re: /(?:^|[{,])\s*(in|instanceof|new|delete|typeof|void|this|function|return|var|if|else|for|while|do|switch|break|continue|try|catch|finally|throw|with|class|const|enum|export|extends|import|super|implements|interface|let|package|private|protected|public|static|yield)\s*:/gm,
    msg: "ES3 不允许保留字直接作为对象属性名，改用 incoming/outgoing 等非保留字",
  },
  {
    id: "es5-array-methods",
    level: "warn",
    re: /\.(forEach|map|filter|reduce|reduceRight|some|every|indexOf|lastIndexOf)\s*\(/g,
    msg: "ES5 数组方法（注意：String.indexOf 是 ES3 合法的，需人工确认接收者类型）",
  },
  {
    id: "string-trim",
    level: "warn",
    re: /\.(trim|trimLeft|trimRight|trimStart|trimEnd)\s*\(/g,
    msg: "String.trim 是 ES5，ExtendScript 多数版本可用但需确认",
  },
];

/* ---------- 掩掉注释与字符串，保留长度以维持行列号 ---------- */
function maskNonCode(src) {
  let out = src;
  const n = src.length;
  let i = 0;
  let state = "code"; // code | line | block | sq | dq
  while (i < n) {
    const c = src[i];
    const c2 = src.substr(i, 2);
    if (state === "code") {
      if (c2 === "//") { state = "line"; out = out.substr(0, i) + "\x00\x00" + out.substr(i + 2); i += 2; continue; }
      if (c2 === "/*") { state = "block"; out = out.substr(0, i) + "\x00\x00" + out.substr(i + 2); i += 2; continue; }
      if (c === "'") { state = "sq"; out = out.substr(0, i) + "\x01" + out.substr(i + 1); i++; continue; }
      if (c === '"') { state = "dq"; out = out.substr(0, i) + "\x02" + out.substr(i + 1); i++; continue; }
      i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; i++; continue; }
      out = out.substr(0, i) + "\x00" + out.substr(i + 1); i++; continue;
    }
    if (state === "block") {
      if (c2 === "*/") { state = "code"; out = out.substr(0, i) + "\x00\x00" + out.substr(i + 2); i += 2; continue; }
      out = out.substr(0, i) + (c === "\n" ? "\n" : "\x00") + out.substr(i + 1); i++; continue;
    }
    // 字符串内部：保留换行以维持行号
    if (state === "sq") {
      if (c === "\\" ) { out = out.substr(0, i) + "\x01\x01" + out.substr(i + 2); i += 2; continue; }
      if (c === "'") { state = "code"; i++; continue; }
      out = out.substr(0, i) + (c === "\n" ? "\n" : "\x01") + out.substr(i + 1); i++; continue;
    }
    if (state === "dq") {
      if (c === "\\") { out = out.substr(0, i) + "\x02\x02" + out.substr(i + 2); i += 2; continue; }
      if (c === '"') { state = "code"; i++; continue; }
      out = out.substr(0, i) + (c === "\n" ? "\n" : "\x02") + out.substr(i + 1); i++; continue;
    }
    i++;
  }
  return out;
}

function toLineCol(src, index) {
  let line = 1, lastNl = -1;
  for (let k = 0; k < index; k++) {
    if (src.charCodeAt(k) === 10) { line++; lastNl = k; }
  }
  return { line, col: index - lastNl };
}

function checkFile(abs) {
  const raw = readFileSync(abs, "utf8").replace(/^\uFEFF/, "");
  const masked = maskNonCode(raw);
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(masked)) !== null) {
      const idx = m.index;
      const { line, col } = toLineCol(masked, idx);
      const srcLine = raw.split("\n")[line - 1] || "";
      hits.push({
        rule: rule.id,
        level: rule.level,
        line,
        col,
        text: m[0],
        msg: rule.msg,
        src: srcLine.trim().slice(0, 120),
      });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.line - b.line || a.col - b.col);
  return hits;
}

/* 构建产物与临时目录里存着同一批源码的副本，扫它们只会让同一处告警
   被重复计数（打包解压出来的 .jsx 也是 .jsx）。 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  ".workbuddy",
]);

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, acc);
    else if (name.toLowerCase().endsWith(".jsx")) acc.push(p);
  }
  return acc;
}

/* ---------- 主流程 ---------- */
const args = process.argv.slice(2);
let files;
if (args.length) {
  files = args.map((a) => resolve(a)).filter((a) => {
    if (!existsSync(a)) { console.error("跳过（不存在）: " + a); return false; }
    return true;
  });
} else {
  files = walk(ROOT, []);
  /* curve_math.js 后缀是 .js（面板要 <script> 加载），但同一份代码也会被
     ExtendScript 的 $.evalFile 执行 —— 所以它必须守 ES3 规则，纳入本检查。
     curve_graph.js 同理：浏览器与 AE 共用同一份图模型。 */
  const shared = join(ROOT, "cep", "com.dreamengine.panel", "engine", "curve_math.js");
  if (existsSync(shared) && !files.includes(shared)) files.push(shared);
  const sharedGraph = join(ROOT, "cep", "com.dreamengine.panel", "engine", "curve_graph.js");
  if (existsSync(sharedGraph) && !files.includes(sharedGraph)) files.push(sharedGraph);
}

let errCount = 0, warnCount = 0, cleanCount = 0;
console.log("=== ExtendScript ES3 合规检查 ===");
console.log("规则：" + RULES.filter((r) => r.level === "error").length + " error / " +
            RULES.filter((r) => r.level === "warn").length + " warn");
console.log("待检 .jsx 文件：" + files.length + "\n");

for (const f of files) {
  const rel = relative(ROOT, f) || f;
  let hits;
  try { hits = checkFile(f); }
  catch (e) { console.log("[读取失败] " + rel + " :: " + e.message); errCount++; continue; }
  const errs = hits.filter((h) => h.level === "error");
  const warns = hits.filter((h) => h.level === "warn");
  errCount += errs.length;
  warnCount += warns.length;
  if (!hits.length) { cleanCount++; console.log("[OK]   " + rel); continue; }
  console.log("[" + (errs.length ? "FAIL" : "WARN") + "] " + rel +
              "  error=" + errs.length + " warn=" + warns.length);
  for (const h of hits) {
    console.log("    " + (h.level === "error" ? "ERR " : "warn") +
                "  L" + h.line + ":" + h.col + "  [" + h.rule + "]  命中「" + h.text + "」");
    console.log("         → " + h.msg);
    if (h.src) console.log("         | " + h.src);
  }
}

console.log("\n=== 汇总 ===");
console.log("文件 " + files.length + " ｜ 干净 " + cleanCount +
            " ｜ ERROR " + errCount + " ｜ WARN " + warnCount);

const jsxInJs = join(ROOT, "cep", "com.dreamengine.panel", "js", "bridge.js");
if (existsSync(jsxInJs)) {
  console.log("\n提示：cep/.../js/bridge.js 内嵌了会被 evalScript 送进 ExtendScript 的 jsx 字符串，");
  console.log("      这部分不受本工具检查，改动 bridge.js 时请人工确认其为 ES3 语法。");
}

if (errCount) {
  console.log("\n结论：存在 " + errCount + " 处 ES3 违规，禁止提交。");
  process.exit(1);
}
console.log("\n结论：无 ERROR 级违规" + (warnCount ? "（" + warnCount + " 处 warn 需人工确认）" : "") + "。");
process.exit(0);
