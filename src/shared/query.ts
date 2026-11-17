// 查询解析的单一 owner：把用户输入的查询串解释为「已解释的条件」。
// 与 Go 端 search.go 的 parseQuery / tokenize 保持同一份语义。
// 本文件只做查询解释（分词、分类、姓名条件判定），运行时搜索（匹配、排序、分页）
// 唯一归属后端 search.go，此处不含这些实现。
//
// 依赖方向单向：grades.ts（年段值域）与 classparse.ts（班级域）→ 本文件。
// 姓名匹配键的归一化（normalizeName）与空白切分（goSpaceSplit）的单一 owner 在
// classparse.ts——classCondition 是它们唯一的生产消费者。本文件只 import 并
// re-export 归一化函数：若反过来由本文件定义，classparse.ts 就要 import 本文件，
// 形成 classparse → query → classparse 的循环依赖。
import type { Grade } from "./grades";
import { gradeAliases, gradeValues } from "./grades";
import { classCondition, classNumberHead, classToken, goSpaceSplit, normalizeName } from "./classparse";

// 归一化函数的出口从本文件透出：消费方（含 Worker 侧）不必知道 owner 文件。
// 定义与理由见 classparse.ts，此处不得出现第二份实现。
export { normalizeName } from "./classparse";

// 查询串的解析结果，即契约语料的声明形状：tokens 是分词中间结果（在分类之前
// 就已确定），nameTokens 是归一化后的姓名匹配键，grade / classNumber 是可选的
// 精确条件。
export interface ParsedQuery {
  tokens: string[];
  nameTokens: string[];
  grade?: Grade;
  classNumber?: number;
}

// 查询分隔符，与 Go 端 search.go 的 querySeparators 同一份语义：用户书写多个
// 条件时的自然分隔（中文逗号、顿号、加号），归一为空白后由空白集合统一切分。
const separators = /[，,、+]+/g;

// tokenize 与 Go 端 search.go 的 tokenize 同形：先归一分隔符，再按 Go 空白集合切分。
// 切分按 goSpaceSplit 而不是 JS 的 \s 近似：两者的差集有两个码位且方向相反，
// 用 \s 会在边界码位上静默与 Go 分叉。
// 也不得用 JS 的 trim 收尾——它会移除首尾的 U+FEFF，而 Go 的 strings.TrimSpace
// 不认 U+FEFF；"␣18班" 因此会在 JS 被削成 "18班"（判为班级条件）、在 Go 整体
// 保留为一个姓名 token。切分本身已过滤空串，无需再 trim。
export function tokenize(raw: string): string[] {
  return raw.replace(separators, " ").split(goSpaceSplit).filter(Boolean);
}

// splitGradeClass 把「年段+班级连写」切成年段与班级两段，语义与 Go 端
// search.go 的同名函数逐条对齐。
//
// 为什么不用一条正则切：年段组与班级组共享汉字字符集，引擎回溯时会把班级部分
// 从中间切开——「高二十二班」的班级部分被切成「十二」而非「二十二」，
// 而数据加载路径 chineseNumberToInt("二十二") 得到 22。同一串字两条路径分裂。
// 改用「最长年段前缀 + 剩余整体交给班级解析」后，两条路径必然同源。
// JS 的 length 与 Go 的 len 同样按 UTF-16 码元计，但最长前缀的比较在这里
// 只用于挑选候选、不用于切片，因此与 Go 端 utf8.RuneCountInString 的差异
// 不会显现（中文年段在两者下长度一致）。
export function splitGradeClass(token: string): { grade: Grade; classPart: string } | null {
  let best = "";
  let grade: Grade | undefined;
  for (const g of gradeValues) {
    if (token.startsWith(g) && g.length > best.length) {
      best = g;
      grade = g;
    }
  }
  for (const [alias, canonical] of gradeAliases) {
    if (token.startsWith(alias) && alias.length > best.length) {
      best = alias;
      grade = canonical;
    }
  }
  if (best === "" || grade === undefined) return null;
  const rest = token.slice(best.length);
  if (rest === "") return null;
  const classPart = rest.endsWith("班") ? rest.slice(0, -1) : rest;
  // 守门只判「开头像班号」，不判整段可解析：「高一同学」是姓名而非连写，
  // 而「一一」开头像班号却解析失败，必须放行到降级路径。
  if (!classNumberHead.test(classPart)) return null;
  return { grade, classPart };
}

// parseGradeInToken 与 Go 端 search.go 的同名函数语义一致：精确匹配。
//
// 曾用子串匹配（token.includes），与 Go 端同样会把「高一鸣」这类含年段串的
// 姓名读成年段条件，使姓名条件被吞掉。Go 端已把标题侧（子串）与查询侧（精确）
// 拆成两个函数；前端没有标题校验的消费方，故只需这一个精确语义。
// 遍历声明的年段值域而非硬编码比较：扩展年段只需在 gradeValues / gradeAliases 追加。
export function parseGradeInToken(token: string): Grade | undefined {
  for (const grade of gradeValues) {
    if (token === grade || token === grade + "班") return grade;
  }
  for (const [alias, grade] of gradeAliases) {
    if (token === alias || token === alias + "班") return grade;
  }
  return undefined;
}

export function parseQuery(raw: string): ParsedQuery {
  const tokens = tokenize(raw);
  const parsed: ParsedQuery = { tokens, nameTokens: [] };

  for (const token of tokens) {
    // 年段+班级连写（"高二三班"）：切分由 splitGradeClass 单点承担，
    // 班级判定与降级策略由 classCondition 单点承担，两个调用点形状不同
    // （连写要额外保留年段条件、纯班级没有年段可保留），策略本身不泄漏。
    const gradeClass = splitGradeClass(token);
    if (gradeClass) {
      parsed.grade = gradeClass.grade;
      const condition = classCondition(gradeClass.classPart, token);
      if (condition.classNo > 0) {
        parsed.classNumber = condition.classNo;
      } else {
        parsed.nameTokens.push(condition.asName);
      }
      continue;
    }
    if (classToken.test(token)) {
      const condition = classCondition(token, token);
      if (condition.classNo > 0) {
        parsed.classNumber = condition.classNo;
      } else {
        parsed.nameTokens.push(condition.asName);
      }
      continue;
    }
    const grade = parseGradeInToken(token);
    if (grade) {
      parsed.grade = grade;
      continue;
    }
    parsed.nameTokens.push(normalizeName(token));
  }
  return parsed;
}

// 判定查询是否含姓名条件（任一 token 解析后成为姓名匹配词）。
// 供界面决定「纯年段/班级查询」提示；替代原先 App.tsx 内嵌的 hasNameCondition 正则，
// 消除查询语义的第三份实现（query.ts / search.go / App.tsx 三拷贝 → 两份 + 消费方）。
export function hasNameCondition(raw: string): boolean {
  return parseQuery(raw).nameTokens.length > 0;
}
