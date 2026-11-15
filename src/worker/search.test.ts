// 搜索运行时语义（匹配、排序、分页）的回归测试，用例从 Go 端 server/search_test.go
// 与 server/schools_test.go 平移。本文件被测的 search.ts 是 search.go 的对等实现，
// 凡 Go 侧承重的不变量都必须在此有对等断言——否则「语义平移」只是一句声明，
// 而移植期的静默分叉恰恰是这次迁移最大的风险。
//
// 语料级对拍消费 docs/query-contract.json。该语料只声明解析结果（条件的唯一事实源），
// 不含执行层的期望命中字段，因此本文件的期望由「语料声明的条件 + 匹配语义」独立
// 推导（见 expectedHits），而不是先跑一遍被测实现再把输出抄进断言——后者对任何
// 行为都恒绿，等于没有断言。
import { describe, expect, it } from "vitest";
import contract from "../../docs/query-contract.json";
import { MAX_LIMIT, PAGE_SIZE } from "../shared/contract";
import type { Grade } from "../shared/grades";
import { parseQuery } from "../shared/query";
import { newStudentSchool, type RosterStudent } from "../shared/student";
import { Search, SearchInSchool, nameScore, nameScoreSum, searchCore } from "./search";

// roster 是 Go 端 newStudent 的对等物：无学校构造路径，SchoolIdx 固定 -1。
// 显式区分它与带学校的构造，是因为排序第二键直接读 schoolIdx，而 -1 必须排最后。
function roster(name: string, grade: Grade, className: string, classNo: number): RosterStudent {
  return newStudentSchool("", name, grade, className, classNo, -1);
}

// testStudents 与 Go 端 search_test.go 的 testStudents 同一份 fixture：
// 覆盖中文姓名、含空白的同一姓名、英文姓名三种匹配分档，以及三个不同班级。
function testStudents(): RosterStudent[] {
  return [
    roster("示例同学", "高三", "18班", 18),
    roster("示 例 同 学", "高一", "6班", 6),
    roster("EXAMPLE STUDENT", "高一", "11班", 11),
  ];
}

// benchStudents 合成 2112 条名单，规模与 Go 端 benchStudents 一致。
// 用途是让 hasMore 的临界格（end == total-1）在每个页宽下都能真实取到：
// 末页处两种判据写法同为 false，抓不到错误；临界格才承重。
function benchStudents(): RosterStudent[] {
  const surnames = ["张", "王", "李", "赵", "陈", "刘", "杨", "黄", "周", "吴"];
  const given = ["伟", "芳", "娜", "敏", "静", "强", "磊", "洋", "艳", "勇", "军", "杰", "娟", "涛", "明", "超"];
  const grades: Grade[] = ["高一", "高二", "高三"];
  const students: RosterStudent[] = [];
  grades.forEach((grade, gi) => {
    for (let classNo = 1; classNo <= 22; classNo++) {
      for (let k = 0; k < 32; k++) {
        const name =
          surnames[(gi * 7 + classNo + k) % surnames.length] +
          given[(gi * 13 + classNo * 3 + k * 5) % given.length] +
          given[(gi * 3 + classNo * 7 + k * 11) % given.length];
        students.push(roster(name, grade, `${classNo}班`, classNo));
      }
    }
  });
  return students;
}

describe("信姓名匹配分档", () => {
  it("完全相等 0、前缀 1、包含 2：升序即「越像越靠前」", () => {
    expect(nameScore("张伟", "张伟")).toBe(0);
    expect(nameScore("张伟", "张")).toBe(1);
    expect(nameScore("伟张", "张")).toBe(2);
  });

  it("nameScoreSum 对多 token 累加", () => {
    expect(nameScoreSum("示例同学", [])).toBe(0);
    expect(nameScoreSum("示例同学", ["示例"])).toBe(1);
    // 前缀 1 加包含 2：多 token 时逐个累加，与 Go 端同语义。
    expect(nameScoreSum("示例同学", ["示例", "同学"])).toBe(3);
  });
});

describe("匹配与条件组合", () => {
  const cases: Array<{ name: string; raw: string; want: number }> = [
    { name: "姓名去空格", raw: "示 例", want: 2 },
    { name: "组合筛选", raw: "高三, 示例同学", want: 1 },
    { name: "加号组合筛选", raw: "高三+示例同学+18班", want: 1 },
    { name: "班级数字", raw: "18", want: 1 },
    { name: "中文班级", raw: "六班", want: 1 },
    { name: "年级数字别名", raw: "高1", want: 2 },
    { name: "混合分隔符", raw: "高一，六班", want: 1 },
    { name: "高一筛选", raw: "高一", want: 2 },
    { name: "高三筛选", raw: "高三", want: 1 },
    { name: "高三数字别名", raw: "高3", want: 1 },
    // 纯数字按班级解析而非姓名：语料声明「223」得到条件 223，本 fixture 无 223 班。
    { name: "超出班级域的数字班级无匹配", raw: "223", want: 0 },
    { name: "空输入", raw: "", want: 0 },
    { name: "纯分隔符顿号", raw: "、", want: 0 },
    { name: "纯分隔符英文逗号", raw: ",", want: 0 },
    { name: "纯分隔符加号", raw: "+", want: 0 },
    { name: "纯分隔符中文逗号", raw: "，", want: 0 },
    { name: "纯分隔符连写", raw: ",,,", want: 0 },
    { name: "空白与分隔符混合", raw: "  、  ", want: 0 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(Search(testStudents(), c.raw, PAGE_SIZE, 0).items.length).toBe(c.want);
    });
  }
});

// 空查询守卫：纯分隔符与纯空白解析不出任何条件。若此处判空退化成「原始串是否为空」，
// 这类输入会让三个条件全部不生效，检索退化成与输入无关的全校返回（Go 端修复前
// 实测输入「、」返回全校 2112 条）。断 total 而不只断 items，是为了区分
// 「没有条件所以空」与「有条件但分页取空」两种形态。
describe("空查询守卫不退化为全校检索", () => {
  it("纯分隔符与纯空白返回空结果集且 total 为 0", () => {
    const students = benchStudents();
    expect(students.length).toBe(2112);
    for (const raw of ["", "  ", "、", "+++", "，,、+", ",,,", "\t\n"]) {
      const got = Search(students, raw, PAGE_SIZE, 0);
      expect(got.total, `输入 ${JSON.stringify(raw)}`).toBe(0);
      expect(got.items).toEqual([]);
      expect(got.hasMore).toBe(false);
    }
  });
});

describe("分页", () => {
  it("两页取完且不重复，越界 offset 钳到匹配条数", () => {
    const students = [...testStudents(), ...testStudents()];
    const first = Search(students, "示例", 2, 0);
    expect(first.total).toBe(4);
    expect(first.items.length).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = Search(students, "示例", 2, 2);
    expect(second.offset).toBe(2);
    expect(second.items.length).toBe(2);
    expect(second.hasMore).toBe(false);
    expect(second.items[0].name === first.items[0].name && second.items[1].name === first.items[1].name).toBe(false);

    const beyond = Search(students, "示例", 2, 999999999999);
    expect(beyond.offset).toBe(4);
    expect(beyond.items.length).toBe(0);
    expect(beyond.hasMore).toBe(false);
  });

  // 分页前置约定由 searchCore 自守：调用方不必记忆「offset 不能为负」。
  it("负 offset 归一到第一页", () => {
    const students = [...testStudents(), ...testStudents()];
    const got = Search(students, "示例", 2, -3);
    expect(got.offset).toBe(0);
    const first = Search(students, "示例", 2, 0);
    expect(got.items.length).toBe(first.items.length);
    expect(got.total).toBe(first.total);
    expect(got.hasMore).toBe(first.hasMore);
  });

  // 与负 offset 对称：limit 侧同样自守，负 limit 不得清空结果集、也不得回显负值。
  it("负 limit 归一到 0 且不回显负值", () => {
    const students = [...testStudents(), ...testStudents()];
    const got = Search(students, "示例", -1, 0);
    expect(got.total).toBeGreaterThan(0);
    expect(got.limit).toBeGreaterThanOrEqual(0);
    expect(got.limit).toBe(0);
    expect(got.items.length).toBeLessThanOrEqual(Search(students, "示例", PAGE_SIZE, 0).items.length);
  });

  // 空查询路径此前在两个钳制之前提前返回，使「分页自守」只在非空路径成立。
  it("空查询同样钳制分页参数", () => {
    const got = Search(testStudents(), "", -3, -5);
    expect(got.limit).toBe(0);
    expect(got.offset).toBe(0);
  });
});

describe("班级与年段精度", () => {
  it("汉字多位数班级精确命中", () => {
    const got = Search(testStudents(), "十一班", PAGE_SIZE, 0);
    expect(got.items.length).toBe(1);
    expect(got.items[0].className).toBe("11班");
  });

  it("超长数字班级按姓名处理，返回空而不抛错", () => {
    expect(Search(testStudents(), "99999999999999999999", PAGE_SIZE, 0).items.length).toBe(0);
  });

  it("姓名含「高」「班」字不被误判为年段或班级", () => {
    const students = [roster("高翔", "高一", "1班", 1), roster("班长", "高二", "2班", 2)];
    expect(Search(students, "高翔", PAGE_SIZE, 0).items.length).toBe(1);
    expect(Search(students, "班长", PAGE_SIZE, 0).items.length).toBe(1);
  });

  // 姓名含完整年段串时按姓名处理（年段在查询侧是精确匹配），
  // 同时纯年段仍必须返回整个年段——只断一侧的话，把判断退化为「一律按姓名处理」
  // 同样会通过（精确查询正常、纯年段查询全空）。
  it("含年段串的姓名不放大为整年段，纯年段仍返回整年段", () => {
    const students = [
      roster("高一鸣", "高一", "1班", 1),
      roster("张伟", "高一", "2班", 2),
      roster("高二峰", "高二", "1班", 1),
    ];
    for (const name of ["高一鸣", "高二峰"]) {
      const parsed = parseQuery(name);
      expect(parsed.nameTokens.length).toBe(1);
      expect(parsed.grade).toBeUndefined();
      const got = Search(students, name, PAGE_SIZE, 0);
      expect(got.total, `查询 ${name}`).toBe(1);
      expect(got.items[0].name).toBe(name);
    }
    for (const raw of ["高一", "高一班", "高1", "高1班"]) {
      expect(Search(students, raw, PAGE_SIZE, 0).total, `查询 ${raw}`).toBe(2);
    }
    const compound = Search(students, "高一2班", PAGE_SIZE, 0);
    expect(compound.items.length).toBe(1);
    expect(compound.items[0].name).toBe("张伟");
  });

  it("年段+班级连写精确到班，本 fixture 无三班时返回空", () => {
    expect(Search(testStudents(), "高三三班", PAGE_SIZE, 0).items.length).toBe(0);
  });

  it("年段+班级连写精确筛选", () => {
    const students = [
      roster("甲", "高二", "1班", 1),
      roster("乙", "高二", "2班", 2),
      roster("丙", "高一", "1班", 1),
      roster("丁", "高二", "12班", 12),
    ];
    const cases: Array<[string, string]> = [
      ["高二一班", "甲"],
      ["高二1班", "甲"],
      ["高一1班", "丙"],
      ["高二十二班", "丁"],
      ["高二，1班", "甲"],
    ];
    for (const [raw, want] of cases) {
      const got = Search(students, raw, PAGE_SIZE, 0);
      expect(got.items.length, `查询 ${raw}`).toBe(1);
      expect(got.items[0].name).toBe(want);
    }
  });
});

// 排序必须对任意输入顺序成立，不依赖调用方已排好序。传入乱序输入把
// 「searchCore 自守排序」钉成接口事实——调用方只有 Worker 一处，
// 「输入已排序」从未作为契约写在任何地方。
describe("排序", () => {
  it("乱序输入仍按年段声明序、班级号升序输出", () => {
    const students = [
      roster("张甲", "高三", "9班", 9),
      roster("张乙", "高一", "3班", 3),
      roster("张丙", "高一", "7班", 7),
      roster("张丁", "高一", "1班", 1),
    ];
    const got = Search(students, "张", PAGE_SIZE, 0);
    expect(got.items.length).toBe(4);
    // 姓名单命中时全部同分，顺序由「年段声明序 → 班级号升序」决定。
    const wantGrades: Grade[] = ["高一", "高一", "高一", "高三"];
    const wantClasses = [1, 3, 7, 9];
    got.items.forEach((item, index) => {
      expect(item.grade, `位置 ${index} 年段`).toBe(wantGrades[index]);
      expect(item.classNo, `位置 ${index} 班号`).toBe(wantClasses[index]);
    });
  });

  // 第一键（匹配分）不得被班级号键掩盖：取样点必须让两键给出相反顺序，
  // 否则一个键会掩盖另一个键的失效。「伟张」得 2 分却坐 1 班，「张伟」得 1 分却坐 2 班。
  it("匹配分优先于班级号，同分时按班级号升序", () => {
    const students = [roster("伟张", "高一", "1班", 1), roster("张伟", "高一", "2班", 2)];
    const got = Search(students, "张", PAGE_SIZE, 0);
    expect(got.items.length).toBe(2);
    expect(got.items[0].name).toBe("张伟");
    expect(got.items[1].name).toBe("伟张");

    const sameScore = [roster("张丙", "高一", "3班", 3), roster("张甲", "高一", "1班", 1)];
    const byClass = Search(sameScore, "张", PAGE_SIZE, 0);
    expect(byClass.items[0].name).toBe("张甲");
    expect(byClass.items[1].name).toBe("张丙");
  });

  // 稳定性：四键全等时必须保持调用方给定顺序，否则同一查询的翻页结果会在
  // 页边界上重复或漏条——items 与 total 都对，肉眼无法分辨。
  it("四键全等时保持输入顺序（稳定排序）", () => {
    const students = [
      roster("张同", "高一", "1班", 1),
      roster("张同", "高一", "1班", 1),
      roster("张同", "高一", "1班", 1),
    ];
    // 用可区分的 className 之外的字段无法区分，故改用 NameKey 相同的不同实例，
    // 通过对象引用确认输出顺序与输入顺序一致。
    const got = Search(students, "张同", PAGE_SIZE, 0);
    expect(got.items.length).toBe(3);
    expect(got.items[0]).toBe(students[0]);
    expect(got.items[1]).toBe(students[1]);
    expect(got.items[2]).toBe(students[2]);
  });

  // 第二键：同分时按学校加载序，未知学校（-1）排最后。学校层归一在
  // schoolSortKey 内完成，比较处不再内联同一约定。
  it("同分时按学校加载序，未知学校排最后", () => {
    const students = [
      newStudentSchool("乙校", "张同", "高一", "一班", 1, 1),
      newStudentSchool("甲校", "张同", "高一", "一班", 1, 0),
      roster("张同", "高一", "一班", 1),
    ];
    const got = Search(students, "张同", PAGE_SIZE, 0);
    expect(got.items.length).toBe(3);
    expect(got.items.map((s) => s.school)).toEqual(["甲校", "乙校", ""]);
  });
});

// hasMore 是前端唯一的翻页依据：为真则「继续加载」按钮显示，点击后按
// offset+limit 再取一页。判据一旦写成 end < total-1，临界格会显示「还有更多」
// 却点出空列表，而 total 与 items 都正确，肉眼无法分辨。
describe("hasMore 判据", () => {
  it("临界格（end == total-1）与整页为真，末页为假", () => {
    const students = benchStudents();
    const total = Search(students, "高一", 1, 0).total;
    expect(total).toBeGreaterThanOrEqual(PAGE_SIZE + 2);

    for (const limit of [1, 3, PAGE_SIZE]) {
      for (const back of [1, PAGE_SIZE]) {
        const offset = total - limit - back;
        if (offset < 0) continue;
        const got = Search(students, "高一", limit, offset);
        const wantMore = offset + got.items.length < got.total;
        expect(got.hasMore, `limit=${limit} offset=${offset}`).toBe(wantMore);
        // 临界格必须被真实取到，否则本用例又退化成末页的零判别力取样。
        if (back === 1) expect(got.items.length).toBe(limit);
      }
    }

    const last = Search(students, "高一", PAGE_SIZE, total);
    expect(last.hasMore).toBe(false);
    expect(last.items).toEqual([]);
  });
});

describe("学校过滤", () => {
  function twoSchools(): RosterStudent[] {
    return [
      newStudentSchool("福清一中", "张三", "高一", "一班", 1, 0),
      newStudentSchool("福清一中", "李四", "高一", "一班", 1, 0),
      newStudentSchool("福清二中", "张三", "高一", "一班", 1, 1),
      newStudentSchool("福清二中", "王五", "高一", "一班", 1, 1),
    ];
  }

  it("精确过滤只返回目标学校", () => {
    const got = SearchInSchool(twoSchools(), "张三", "福清一中", PAGE_SIZE, 0);
    expect(got.total).toBe(1);
    expect(got.items[0].school).toBe("福清一中");
  });

  it("空 school 等于不过滤", () => {
    expect(SearchInSchool(twoSchools(), "张三", "", PAGE_SIZE, 0).total).toBe(2);
  });

  it("不存在的学校名返回空，不退化为全校", () => {
    expect(SearchInSchool(twoSchools(), "张三", "不存在的学校", PAGE_SIZE, 0).total).toBe(0);
  });

  // 空查询守卫不因学校过滤器而改变：学校选择器只缩小范围，不是浏览全校的入口。
  it("仅 school 而无姓名/年段/班级条件时返回空", () => {
    const students = twoSchools();
    for (const raw of ["", "  ", "，", "、"]) {
      expect(SearchInSchool(students, raw, "福清一中", PAGE_SIZE, 0).total, `q=${JSON.stringify(raw)}`).toBe(0);
    }
  });

  it("学校与年段/班级组合过滤", () => {
    const students = [
      newStudentSchool("福清一中", "张三", "高一", "一班", 1, 0),
      newStudentSchool("福清一中", "张三", "高一", "二班", 2, 0),
      newStudentSchool("福清一中", "张三", "高二", "一班", 1, 0),
    ];
    expect(SearchInSchool(students, "张三 高一", "福清一中", PAGE_SIZE, 0).total).toBe(2);
    expect(SearchInSchool(students, "张三 高一 二班", "福清一中", PAGE_SIZE, 0).total).toBe(1);
  });

  // Review Focus 3：校名由用户在下拉之外无法构造，但校名本身可以是任何字符串，
  // 含括号与加号的校名在真实数据里存在（校区、联合校）。校名过滤必须是精确
  // 字符串比较：当作正则会被解释成分组/量词，当作查询串会被分隔符切开，
  // 两种都会静默命中错误的学校。搜索侧的姓名 token 同样不得走正则。
  it("校名含括号与加号时按字面量精确匹配", () => {
    const students = [
      newStudentSchool("福清一中(新校区)", "张一", "高一", "1班", 1, 0),
      newStudentSchool("福清一中", "张二", "高一", "1班", 1, 1),
      newStudentSchool("一中+二中", "张三", "高一", "1班", 1, 2),
      newStudentSchool("一中二中", "张四", "高一", "1班", 1, 3),
    ];
    const paren = SearchInSchool(students, "张", "福清一中(新校区)", PAGE_SIZE, 0);
    expect(paren.total).toBe(1);
    expect(paren.items[0].name).toBe("张一");

    const plus = SearchInSchool(students, "张", "一中+二中", PAGE_SIZE, 0);
    expect(plus.total).toBe(1);
    expect(plus.items[0].name).toBe("张三");

    // 反向：加了分组/量词语义的实现在此命中多条，字面量实现命中 0 条。
    expect(SearchInSchool(students, "张", "福清一中.*", PAGE_SIZE, 0).total).toBe(0);
  });

  // searchCore 的 school 参数为空串即不过滤，Search 是它的空学校特化，
  // 两条入口行为必须完全相同（否则 4 参历史入口会与 Worker 入口分叉）。
  it("Search 与 searchCore(空 school) 等价", () => {
    const students = twoSchools();
    const a = Search(students, "张三", 1, 1);
    const b = searchCore(students, "张三", "", 1, 1);
    expect(a).toEqual(b);
  });
});

describe("姓名 token 不按正则解释", () => {
  // 姓名 token 走纯字符串子串判定。含正则元字符的输入必须是字面量子串，
  // 否则构造 RegExp 会抛错或匹配到完全不相关的人。
  it("含括号的姓名 token 按字面量匹配", () => {
    const students = [roster("张(一)", "高一", "1班", 1), roster("张一", "高一", "1班", 1)];
    // /张(一)/ 只能匹配「张一」（括号是分组），字面量子串匹配才命中真正的「张(一)」。
    expect(Search(students, "张(一)", PAGE_SIZE, 0).items.map((s) => s.name)).toEqual(["张(一)"]);
  });

  it("加号是查询分隔符：含加号姓名由无加号查询子串命中", () => {
    const students = [roster("张+二", "高一", "1班", 1), roster("张三", "高一", "1班", 1)];
    // 「张+二」被解析成姓名「张」与班级「二」（fixture 无 2 班，故 0 条），
    // 与 Go 端分隔符语义一致；下方验证含加号的姓名能被前缀子串命中。
    expect(Search(students, "张+二", PAGE_SIZE, 0).total).toBe(0);
    expect(new Set(Search(students, "张", PAGE_SIZE, 0).items.map((s) => s.name))).toEqual(
      new Set(["张+二", "张三"]),
    );
  });

  it("星号按字面量处理：作为正则会被解释成量词", () => {
    const students = [roster("张三", "高一", "1班", 1)];
    // 子串语义下「张*」不在任何 nameKey 中 → 0；正则语义 /张*/ 会命中张三。
    expect(Search(students, "张*", PAGE_SIZE, 0).total).toBe(0);
    expect(Search(students, "*", PAGE_SIZE, 0).total).toBe(0);
  });
});

// 语料级对拍：docs/query-contract.json 是条件的唯一事实源，但只声明解析结果
// （nameTokens / grade / classNumber），没有执行层的期望命中字段。因此本组用例的
// 期望由语料声明的条件独立推导：命中 = 同时满足全部声明条件的样本；
// 语料声明「零条件」时命中必然为空集（绝不全校）。推导不经过被测实现，
// 所以语料层与实现层的分叉会在这里暴露。
interface ContractCase {
  raw: string;
  tokens: string[];
  nameTokens: string[];
  grade: string | null;
  classNumber: number | null;
}

const contractCases = contract.cases as ContractCase[];

// 语料级对拍的样本集：覆盖三个年段与多个班级，使语料里的年段/班级条件
// 既有命中样本也有未命中样本，避免断言在整个语料上恒为空集。
function corpusStudents(): RosterStudent[] {
  return [
    newStudentSchool("福清一中", "张三", "高一", "1班", 1, 0),
    newStudentSchool("福清一中", "张三丰", "高一", "6班", 6, 0),
    newStudentSchool("福清一中", "示例同学", "高三", "18班", 18, 0),
    newStudentSchool("福清二中", "李四", "高二", "3班", 3, 1),
    newStudentSchool("福清二中", "王五", "高二", "11班", 11, 1),
    newStudentSchool("福清二中", "高翔", "高一", "11班", 11, 1),
    newStudentSchool("福清二中", "高一鸣", "高一", "2班", 2, 1),
    newStudentSchool("福清二中", "班长", "高二", "2班", 2, 1),
    newStudentSchool("福清二中", "高一同学", "高一", "3班", 3, 1),
    newStudentSchool("福清二中", "赵六", "高三", "22班", 22, 1),
  ];
}

// expectedHits 是匹配语义的声明式参照实现，输入完全是语料字段：
// 姓名条件为主串且全部 token 都命中，年段与班级为精确相等。
function expectedHits(students: RosterStudent[], c: ContractCase): RosterStudent[] {
  if (c.nameTokens.length === 0 && c.grade === null && c.classNumber === null) return [];
  return students.filter(
    (s) =>
      c.nameTokens.every((token) => s.nameKey.includes(token)) &&
      (c.grade === null || s.grade === c.grade) &&
      (c.classNumber === null || s.classNo === c.classNumber),
  );
}

describe("语料级匹配对拍", () => {
  it("语料非空，且既有命中样本也有零条件样本", () => {
    expect(contractCases.length).toBeGreaterThan(0);
    const students = corpusStudents();
    const withHits = contractCases.filter((c) => expectedHits(students, c).length > 0);
    const zeroCondition = contractCases.filter(
      (c) => c.nameTokens.length === 0 && c.grade === null && c.classNumber === null,
    );
    expect(withHits.length).toBeGreaterThan(0);
    expect(zeroCondition.length).toBeGreaterThan(0);
  });

  for (const c of contractCases) {
    it(`执行层命中与语料声明的条件一致 ${JSON.stringify(c.raw)}`, () => {
      const students = corpusStudents();
      const want = expectedHits(students, c);
      const got = Search(students, c.raw, MAX_LIMIT, 0);
      expect(got.total).toBe(want.length);
      expect(new Set(got.items.map((s) => s.name))).toEqual(new Set(want.map((s) => s.name)));
    });
  }
});
