// 领域学生模型的单一 owner：RosterStudent 是 Worker 侧的领域形状，
// 含 nameKey / classNo / gradeIdx / schoolIdx 四个派生字段，与前端 wire 形状
// src/types.ts 的 Student（name / school / grade / className）不是同一个类型。
// 本文件只定义领域形状与构造语义，wire 映射由独立的序列化层承担。
//
// 构造语义从 Go 端 server/search.go 平移：newStudentSchool 对应同名函数，
// gradeOrder / schoolSortKey 对应 search.go 尾部两个纯函数。派生字段在加载期
// 预计算，避免排序热路径反复正则解析班级号、反复归一化姓名。
//
// 所有 RosterStudent 必须经本文件的构造入口生成：排序比较直接读派生字段，
// 绕过构造会导致排序静默错乱——这不是理论上成立，Go 端就是先踩过
// 「部分 Student 漏填派生字段、排序结果静默变错」才把构造收口的。
//
// 依赖方向单向：grades.ts（年段值域）与 query.ts（姓名匹配键归一化出口）→ 本文件。
// nameKey 的归一化实现 owner 在 classparse.ts，经 query.ts re-export 后从
// 本文件 import——此处不得出现第二份 normalizeName 实现。
import type { Grade } from "./grades";
import { gradeValues } from "./grades";
import { normalizeName } from "./query";

// 领域学生形状：nameKey 是姓名匹配键（大写去空白后的归一化形态），
// classNo 为 0 表示班级格式非法；gradeIdx 未知年段为 len(gradeValues)；
// schoolIdx 为 -1 表示未知学校（无 school 的旧构造路径），排序时排最后。
export interface RosterStudent {
  name: string;
  nameKey: string;
  school: string;
  grade: Grade;
  className: string;
  classNo: number;
  gradeIdx: number;
  schoolIdx: number;
}

// newStudentSchool 是数据加载路径（含学校）的构造入口，一次性填充派生字段。
// classNo 已由调用方解析（parseClassName 归约三态，非法与溢出按 0 传入），
// 本函数不重新解析、原样保留；gradeIdx 由 gradeOrder 派生；nameKey 取
// normalizeName 的归一化结果。
export function newStudentSchool(
  school: string,
  name: string,
  grade: Grade,
  className: string,
  classNo: number,
  schoolIdx: number,
): RosterStudent {
  return {
    name,
    nameKey: normalizeName(name),
    school,
    grade,
    className,
    classNo,
    gradeIdx: gradeOrder(grade),
    schoolIdx,
  };
}

// gradeOrder 返回年段自然顺序，用于跨年段同分排序。
// 顺序来源于 gradeValues 声明序，扩展年段时只需在 gradeValues 末尾追加；
// 未知年段返回 len(gradeValues)，排在所有声明年段之后（与 Go 端同语义）。
export function gradeOrder(grade: Grade): number {
  for (let index = 0; index < gradeValues.length; index++) {
    if (gradeValues[index] === grade) {
      return index;
    }
  }
  return gradeValues.length;
}

// schoolSortKey 把 schoolIdx 归一成可比较键：-1（未知学校）排到所有真实学校
// 之后。归一在这里而不是比较处内联，避免两个调用点各写一次同一约定。
export function schoolSortKey(idx: number): number {
  return idx < 0 ? 1 << 30 : idx;
}