import { describe, expect, it } from "vitest";
import type { Grade } from "./grades";
import { gradeValues } from "./grades";
import { parseClassName } from "./classparse";
import { normalizeName } from "./query";
import { gradeOrder, newStudentSchool, schoolSortKey } from "./student";

// 领域学生模型：构造即派生（nameKey / classNo / gradeIdx / schoolIdx）。
// 断言从 Go 端 server/search_test.go 的 TestNewStudentFillsDerivedFields 平移。
// 排序比较直接读派生字段，此处的断言锁住构造端确实填充了它们：零值会让排序
// 静默错乱，而不是报错——所以派生字段必须有测试，不能靠「构造看起来没问题」。
describe("newStudentSchool 基础字段与派生字段", () => {
  it("基础字段原样透传，gradeIdx 按声明序派生", () => {
    const student = newStudentSchool("福清一中", "张三", "高二", "18班", 18, 0);
    expect(student.name).toBe("张三");
    expect(student.nameKey).toBe("张三");
    expect(student.school).toBe("福清一中");
    expect(student.grade).toBe("高二");
    expect(student.className).toBe("18班");
    expect(student.classNo).toBe(18);
    // 高二在 gradeValues 中下标为 1
    expect(student.gradeIdx).toBe(1);
    expect(student.schoolIdx).toBe(0);
  });

  it("nameKey 是大写去空白后的匹配键", () => {
    const spaced = newStudentSchool("", "张 三", "高一", "6班", 6, -1);
    expect(spaced.nameKey).toBe("张三");
    const mixedCase = newStudentSchool("", "AbC", "高一", "1班", 1, 0);
    expect(mixedCase.nameKey).toBe("ABC");
  });

  it("nameKey 与 normalizeName 同源，不是第二份归一化实现", () => {
    for (const name of ["张 三", "  EXAMPLE student ", "李四", "\u3000张 三", ""]) {
      expect(newStudentSchool("", name, "高一", "1班", 1, 0).nameKey).toBe(normalizeName(name));
    }
  });

  it("classNo 非法记 0：归约在调用方，构造端不重新解析", () => {
    // 调用方先用 parseClassName 归约三态，非法时传 0；构造端原样保留。
    const valid = parseClassName("18班");
    expect(newStudentSchool("", "王五", "高二", "18班", valid.valid ? valid.classNo : 0, 0).classNo).toBe(18);
    const invalid = parseClassName("未知");
    const bad = newStudentSchool("", "李四", "高一", "未知", invalid.valid ? invalid.classNo : 0, 0);
    expect(bad.classNo).toBe(0);
    // className 保留用户/数据里的原始形态，不因解析失败而被清空或改写
    expect(bad.className).toBe("未知");
  });

  it("schoolIdx 透传，未知学校为 -1", () => {
    expect(newStudentSchool("", "张三", "高一", "1班", 1, -1).schoolIdx).toBe(-1);
    expect(newStudentSchool("福清一中", "张三", "高一", "1班", 1, 7).schoolIdx).toBe(7);
  });
});

// 年段自然顺序来源于 gradeValues 的声明序，遍历断言使扩展年段时自动覆盖。
describe("gradeOrder 声明序", () => {
  it("每个声明年段取其声明下标", () => {
    gradeValues.forEach((grade, index) => {
      expect(gradeOrder(grade)).toBe(index);
    });
  });

  it("未知年段返回 len(gradeValues)，排在所有声明年段之后", () => {
    // 类型上 Grade 三值穷尽，运行时数据仍可能带来未声明年段（Go 端同语义），
    // 此处刻意越过类型边界，锁住降级返回而不是抛错或返回 0。
    const unknown = "高四" as unknown as Grade;
    expect(gradeOrder(unknown)).toBe(gradeValues.length);
  });
});

// 未知学校（-1）排到所有真实学校之后：归一在 schoolSortKey 单点完成，
// 两个排序调用点不必各写一次同一约定。
describe("schoolSortKey 未知学校排最后", () => {
  it("未知学校（-1）归一为 1 << 30", () => {
    expect(schoolSortKey(-1)).toBe(1 << 30);
  });

  it("真实学校下标原样返回", () => {
    expect(schoolSortKey(0)).toBe(0);
    expect(schoolSortKey(7)).toBe(7);
  });

  it("任何真实学校键都小于未知学校键", () => {
    for (const idx of [0, 1, 1000]) {
      expect(schoolSortKey(idx)).toBeLessThan(schoolSortKey(-1));
    }
  });
});
