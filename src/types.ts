// Grade 年段值域的声明与两向完整性检查（GradeDomainGap）都在
// src/shared/grades.ts（单一 owner），ParsedQuery 的定义在 src/shared/query.ts
// （查询解析单一 owner），本文件只做 re-export：新增或修改一律改 shared 下
// 对应文件，此处不持有第二份声明。
// import 与 export 分成两句是因为 Student 在本文件内要用到 Grade——
// `export type { Grade } from "..."` 只转出、不建立本地绑定。
import type { Grade } from "./shared/grades";

export type { Grade };

// 查询串解析结果：定义在 shared/query.ts，本文件只 re-export，防消费方
// 从 types.ts 拿到与实现分裂的第二份形状。
export type { ParsedQuery } from "./shared/query";

export interface Student {
  name: string;
  school: string;
  grade: Grade;
  className: string;
}

// /api/schools 响应体：学校下拉候选（仅含高中年级的学校）。
export interface SchoolsResponse {
  schools: string[];
}

export interface SearchResponse {
  items: Student[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export type SearchState = "idle" | "editing" | "loading" | "success" | "duplicate" | "empty" | "error";
