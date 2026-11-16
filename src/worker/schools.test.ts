// 学校下拉派生的回归测试，用例从 Go 端 server/schools_test.go 平移：
// TestSchoolListOnlyHighSchools（小学校不入下拉）、TestSchoolListOrderStable
// （下拉顺序与加载序一致）、TestSchoolListEmptyWhenNoHighSchool（无高中校时为空），
// 并补齐去重、空校名、未知年段三格——这三条都在 Go 实现里承重，
// 而原用例对去重与空校名只做了间接覆盖。
//
// 未识别年段的学生不经 newStudentSchool 构造：它的 grade 参数类型是 Grade 联合
//（只声明高一/高二/高三），类型层面写不出「一年级」。加载期的真实形状是
// grade 保留原始串、gradeIdx 越界（等于 gradeValues.length），因此这里直接
// 构造该形状，越界断言只集中在 unknownGrade 一处。
import { describe, expect, it } from "vitest";
import { gradeValues, type Grade } from "../shared/grades";
import { newStudentSchool, type RosterStudent } from "../shared/student";
import { schoolList } from "./schools";

// 未识别年段在运行时的取值：加载器未匹配到声明年段时原样保留年级名。
// 类型断言集中在此，其余用例一律走构造入口，避免越界点散落。
const unknownGrade = "一年级" as unknown as Grade;

// primaryStudent 造一名未识别年段（小学）学生。nameKey 直接用原名：
// 中文姓名无空白、无大小写差异，本用例不消费 nameKey。
function primaryStudent(school: string, name: string, schoolIdx: number): RosterStudent {
  return {
    name,
    nameKey: name,
    school,
    grade: unknownGrade,
    className: "一班",
    classNo: 1,
    gradeIdx: gradeValues.length,
    schoolIdx,
  };
}

// highStudent 造一名高中生，走构造入口以免漏填派生字段。
function highStudent(school: string, name: string, grade: Grade, schoolIdx: number): RosterStudent {
  return newStudentSchool(school, name, grade, "一班", 1, schoolIdx);
}

describe("schoolList 学校下拉派生", () => {
  // 对应 Go 端 TestSchoolListOnlyHighSchools：小学学生同样被加载（仍可被全局
  // 搜索命中），只是不进入下拉候选。
  it("只列含高中年段的学校，仅小学的学校不下拉但学生仍参与名单", () => {
    const students = [highStudent("福清一中", "张三", "高一", 0), primaryStudent("某小学", "小明", 1)];
    expect(students.length).toBe(2);
    expect(schoolList(students)).toEqual(["福清一中"]);
  });

  // 对应 Go 端 TestSchoolListEmptyWhenNoHighSchool：下拉不得因为「有数据」就
  // 退化为「所有学校」，小学年段不是下拉的准入条件。
  it("全部为小学时下拉为空", () => {
    expect(schoolList([primaryStudent("某小学", "小明", 0)])).toEqual([]);
  });

  // 顺序 = 加载序（SchoolIdx 升序）。输入刻意让首现顺序与加载序相反：
  // 若实现退化为「按首现顺序输出」，此例立刻失败；两个用例同序的写法
  // 对这条不变量没有判别力。
  it("顺序按 SchoolIdx 升序（加载序），与输入出现顺序无关", () => {
    const students = [
      highStudent("乙校", "乙生", "高二", 1),
      highStudent("甲校", "甲生", "高一", 0),
      highStudent("丙校", "丙生", "高三", 2),
    ];
    expect(schoolList(students)).toEqual(["甲校", "乙校", "丙校"]);
  });

  // 去重：校名是下拉的键，同一校名重复出现会让下拉出现重复选项。
  it("同一学校多名学生只出现一次", () => {
    const students = [
      highStudent("福清一中", "张三", "高一", 0),
      highStudent("福清一中", "李四", "高三", 0),
      highStudent("福清二中", "王五", "高二", 1),
    ];
    expect(schoolList(students)).toEqual(["福清一中", "福清二中"]);
  });

  // 空校名的学生必须被跳过：真实加载期会拒绝空校名，但派生侧自守，
  // 否则下拉里会多出一个空选项（选中它等于「不按学校过滤」的歧义入口）。
  it("校名为空的学生跳过，不产生空串选项", () => {
    const students = [highStudent("", "无校生", "高一", -1), highStudent("福清一中", "张三", "高一", 0)];
    expect(schoolList(students)).toEqual(["福清一中"]);
  });

  // 未知年段不使其学校进入下拉；同一学校只要另有一名高中生，仍应进入。
  // 两侧同时断言，避免实现退化成「凡出现的学校一律收录」或「一旦含未知年段就整校排除」。
  it("未知年段不使该校进入下拉，同校另有高中生时仍进入", () => {
    expect(schoolList([primaryStudent("某小学", "小明", 0), primaryStudent("某小学", "小红", 0)])).toEqual([]);

    const mixed = [primaryStudent("实验学校", "小明", 0), highStudent("实验学校", "张三", "高一", 0)];
    expect(schoolList(mixed)).toEqual(["实验学校"]);
  });

  it("空名单返回空数组", () => {
    expect(schoolList([])).toEqual([]);
  });
});
