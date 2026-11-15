// 年段值域声明的不变量。
//
// 这组断言锁的不是「解析用的正则长什么样」，而是「声明本身完整且自洽」：
// 别名必须映射回已声明的规范名，否则前端会产出不在 Grade 值域内的年段。
// 用例从 src/lib/query.test.ts 的 gradeDomain 用例平移而来（去掉 parseQuery
// 依赖，只测声明本体；query.test.ts 中旧用例在 Task 3 随测试文件一并移动）。
//
// 「Grade 联合与年段值域互相完整」这条反向完整性由编译器强制：
// grades.ts 内的 GradeDomainGap 检查在 Grade 联合出现 gradeValues 未声明的
// 年段时直接报 tsc 错误并点名缺失项，因此本文件不重复手抄枚举数组——手抄
// 副本在 Grade 联合追加成员时不会跟着长，断言存在却不承重它声称的对象。
import { describe, expect, expectTypeOf, it } from "vitest";
import { gradeAliases, gradeDomain, gradeValues } from "./grades";
import type { Grade } from "./grades";

describe("gradeDomain", () => {
  it("规范年段恰为高一、高二、高三", () => {
    expect(gradeDomain.values).toEqual(["高一", "高二", "高三"]);
    expect(gradeValues).toEqual(["高一", "高二", "高三"]);
  });

  it("别名恰为高1、高2、高3三条映射", () => {
    expect(gradeDomain.aliases).toEqual([
      ["高1", "高一"],
      ["高2", "高二"],
      ["高3", "高三"],
    ]);
  });

  it("每个别名都映射回已声明的规范年段", () => {
    for (const [alias, grade] of gradeDomain.aliases) {
      expect(gradeDomain.values).toContain(grade);
      // 别名与规范名不重合：别名存在正是为了另一种书写。
      expect(gradeDomain.values).not.toContain(alias);
    }
  });

  it("规范年段无重复", () => {
    expect(gradeDomain.values.length).toBe(new Set(gradeDomain.values).size);
  });

  it("gradeValues 与别名规范名都属于 Grade 联合", () => {
    // 类型层断言：gradeValues 的成员与别名的规范名都必须是 Grade 联合内的值。
    expectTypeOf<(typeof gradeValues)[number]>().toMatchTypeOf<Grade>();
    expectTypeOf<(typeof gradeAliases)[number][1]>().toMatchTypeOf<Grade>();
  });
});