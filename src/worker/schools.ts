// 学校下拉派生的单一 owner：把 Go 端 server/schools.go 的 schoolList 平移为
// TypeScript。年段值域一律从 shared/grades 取值，本文件不持有第二份年段清单——
// 手抄副本在扩展年段时不会跟着长，会让「小学不入下拉」的边界静默移位。
//
// 派生规则与 Go 端同语义：只保留至少有一名学生的年段属于 gradeValues 的学校。
// 小学年段（一年级~六年级等）不在 gradeValues 内，其学校因此不进下拉，
// 但学生本身仍在名单里、仍可被全局搜索命中——「可搜索」与「可下拉选择」
// 是两个不同的准入，前者看学生，后者看学校是否提供高中入口。
//
// 顺序 = 加载序（SchoolIdx 升序）。SchoolIdx 由加载器按目录文件名排序后的
// 学校首次出现序分配，因此「按 SchoolIdx 排序」等于「按加载时看到的学校
// 顺序排序」，下拉顺序在多次请求之间稳定，不随列表遍历顺序变化。
import { gradeValues } from "../shared/grades";
import type { RosterStudent } from "../shared/student";

// schoolList 从学生快照派生出「进入下拉的高中校名列表」。
// 校名是下拉的键：同名只出现一次，空校名跳过（空串选项等价于「不按学校
// 过滤」的歧义入口，不能作为可选项暴露）。
export function schoolList(students: RosterStudent[]): string[] {
  const seen = new Set<string>();
  const candidates: { school: string; schoolIdx: number; index: number }[] = [];

  for (const student of students) {
    if (student.school === "") continue;
    // 未识别年段（gradeIdx 等于 gradeValues.length）不因这条学生使该校进入
    // 下拉。注意方向：条件是「这条学生不是高中生」，不是「该校没有高中生」，
    // 同校其余高中生仍会正常收录。
    if (student.gradeIdx >= gradeValues.length) continue;
    if (seen.has(student.school)) continue;
    seen.add(student.school);
    candidates.push({ school: student.school, schoolIdx: student.schoolIdx, index: candidates.length });
  }

  // 按 SchoolIdx 升序。同一 SchoolIdx 对应两所不同校名只有在校名映射被破坏时
  // 才可能出现（加载器保证校名与 SchoolIdx 一一对应），此时以首现序作末键：
  // 装饰索引后，稳定性由实现自身提供，不再依赖 Array.prototype.sort 的规范承诺。
  candidates.sort((a, b) => a.schoolIdx - b.schoolIdx || a.index - b.index);
  return candidates.map((entry) => entry.school);
}
