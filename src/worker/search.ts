// 搜索运行时语义（匹配、排序、分页）的单一 owner：把 Go 端 server/search.go 的
// searchCore 逐条平移为 TypeScript。本文件只执行、不解析：查询串的解释
// （分词、条件分类、无法解析时的姓名降级）唯一归属 shared/query.ts，学生
// 领域形状与派生字段唯一归属 shared/student.ts，此处不持有第二份实现。
//
// Go 侧注释锁定的五条不变量在此逐条保留，顺序本身就是语义的一部分：
// 1. 分页钳制必须先于空查询的提前返回，否则空查询会把负 limit/offset 原样
//    回显进响应，「分页自守」的承诺就变成有条件的；
// 2. 判空依据是「解析后是否存在任何条件」，而不是「原始串剥空白后是否为空」。
//    纯分隔符（「、」「+++」）与纯空白都解析不出条件，必须退化为空结果集，
//    绝不允许落入「三个条件全都不约束」的全校检索（Go 端修复前实测返回
//    全校 2112 条，与 v0.9.1「无法解析的班级 token 不得静默丢弃」同源）；
// 3. 学校过滤器不改变这条守卫：只有学校、没有姓名/年段/班级条件时仍返回
//    空结果而非「整个学校全量」，学校选择器只用于缩小范围；
// 4. 排序四键且必须稳定：匹配分 → 学校加载序 → 年段声明序 → 班级号；
// 5. offset 上界钳制到匹配条数，hasMore 的判据是「本页取完后仍有剩余」。

import { parseQuery } from "../shared/query";
import { schoolSortKey, type RosterStudent } from "../shared/student";

// 搜索响应形状，与 Go 端 SearchResponse 的 JSON 契约同形。
export interface SearchResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// nameScore 给单个姓名 token 的匹配分档：完全相等 0、前缀匹配 1、包含匹配 2，
// 越低越优先。分档方向不能反：排序第一键按升序比较，档位小者靠前。
export function nameScore(nameKey: string, token: string): 0 | 1 | 2 {
  if (nameKey === token) return 0;
  if (nameKey.startsWith(token)) return 1;
  return 2;
}

// nameScoreSum 汇总多个姓名 token 的匹配总分，供排序第一键使用（越低越优先）。
export function nameScoreSum(nameKey: string, tokens: string[]): number {
  let total = 0;
  for (const token of tokens) {
    total += nameScore(nameKey, token);
  }
  return total;
}

// searchCore 是匹配/排序/分页语义的唯一实现，school 为 "" 时表示不过滤学校。
export function searchCore(
  students: RosterStudent[],
  raw: string,
  school: string,
  limit: number,
  offset: number,
): SearchResponse<RosterStudent> {
  // 负向钳制必须先于任何提前返回完成：空查询会把钳制后的值回显进响应，
  // 若把钳制放在守卫之后，负 limit/offset 会被原样带出去。offset 的上界
  // 钳制依赖匹配结果长度，留在匹配循环之后。
  if (limit < 0) limit = 0;
  if (offset < 0) offset = 0;

  const query = parseQuery(raw);
  const nameTokens = query.nameTokens;
  const grade = query.grade;
  const classNumber = query.classNumber ?? 0;

  // 判空依据是「解析后是否存在任何条件」。纯分隔符输入在解析阶段就产出零
  // token（query.ts 的 tokenize 先把分隔符归一为空白），不满足任何条件，
  // 必须按空查询处理；若退化成剥空白后判空，这类输入会让三个条件全部
  // 不生效，检索退化成与用户输入无关的全校返回。
  if (nameTokens.length === 0 && grade === undefined && classNumber === 0) {
    return { items: [], total: 0, limit, offset, hasMore: false };
  }

  const matches: RosterStudent[] = [];
  for (const item of students) {
    let ok = true;
    for (const token of nameTokens) {
      // 姓名匹配是纯字符串子串判定，不用正则：token 来自用户输入，可能含
      // 「(」「+」「*」等正则元字符，构造 RegExp 会把字面量解释成模式；
      // 也不用 \s 之类的等价近似替代 strings.Contains 语义，两端必须逐字一致。
      if (!item.nameKey.includes(token)) {
        ok = false;
        break;
      }
    }
    if (grade !== undefined && item.grade !== grade) ok = false;
    if (classNumber > 0 && item.classNo !== classNumber) ok = false;
    // 学校过滤：精确字符串比较（来自下拉选择，不进查询解析契约）。校名可能
    // 含括号、加号等字符，任何把校名当模式或查询串处理的做法都会改变命中集。
    if (school !== "" && item.school !== school) ok = false;
    if (ok) {
      matches.push(item);
    }
  }

  // 匹配分在排序前对每条算一次：比较器会被调用 O(n log n) 次，而分数只依赖
  // 学生与查询，与比较的另一方无关，重复计算是纯浪费。
  const decorated = matches.map((item, index) => ({
    item,
    index,
    score: nameScoreSum(item.nameKey, nameTokens),
  }));

  // 排序四键 + 索引装饰保证稳定。JS 的 Array.prototype.sort 在规范层面外
  // 并不承诺稳定（ES2019 之前的行为，且依赖引擎版本），而四键全等的记录
  // 必须保持调用方给定顺序——翻页按 offset 切结果，顺序不稳会导致页边界
  // 上重复或漏条，且 items 与 total 都对、肉眼无法分辨。给每条装饰上输入
  // 索引作为末键，排序稳定性由实现自身提供，不再依赖引擎行为。
  decorated.sort((a, b) => {
    // 第一键：匹配分（越低越优先）。与班级号升序方向相反，
    // 因此这一键的失效不会被后续键自然掩盖。
    const scoreDiff = a.score - b.score;
    if (scoreDiff !== 0) return scoreDiff;
    // 第二键：学校加载序，同分时按校名首次出现序，未知学校（-1）排最后。
    // 归一在 schoolSortKey 内完成，比较处不重复内联同一约定。
    const schoolDiff = schoolSortKey(a.item.schoolIdx) - schoolSortKey(b.item.schoolIdx);
    if (schoolDiff !== 0) return schoolDiff;
    // 第三键：年段声明序（高一 → 高二 → 高三），未知年段排最后。
    const gradeDiff = a.item.gradeIdx - b.item.gradeIdx;
    if (gradeDiff !== 0) return gradeDiff;
    // 第四键：班级号升序。
    const classDiff = a.item.classNo - b.item.classNo;
    if (classDiff !== 0) return classDiff;
    // 末键：输入索引。四键全等时保持调用方给定顺序，即稳定排序的落点。
    return a.index - b.index;
  });
  const sorted = decorated.map((entry) => entry.item);

  // offset 上界钳制到匹配条数，越界时取最近有效边界；负向钳制已在函数开头
  // 完成（必须先于空查询的提前返回），此处只处理依赖匹配结果的部分。
  if (offset > sorted.length) {
    offset = sorted.length;
  }
  const end = limit < sorted.length - offset ? offset + limit : sorted.length;
  return {
    items: sorted.slice(offset, end),
    total: sorted.length,
    limit,
    offset,
    // hasMore 等价于「本页取完后仍有剩余」：end 取到末尾则为 false，
    // 否则为 true。这是前端唯一的翻页依据。
    hasMore: end < sorted.length,
  };
}

// Search 保持历史签名（4 参、无学校过滤）：与 Go 端同名函数对应。
// 学校过滤请用 SearchInSchool。
export function Search(
  students: RosterStudent[],
  raw: string,
  limit: number,
  offset: number,
): SearchResponse<RosterStudent> {
  return searchCore(students, raw, "", limit, offset);
}

// SearchInSchool 是带学校过滤的查询入口（Worker 路由使用）。
// school 精确匹配校名（来自下拉选择，不进查询解析契约）。
export function SearchInSchool(
  students: RosterStudent[],
  raw: string,
  school: string,
  limit: number,
  offset: number,
): SearchResponse<RosterStudent> {
  return searchCore(students, raw, school, limit, offset);
}