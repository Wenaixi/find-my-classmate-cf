// 名单加载守门的回归测试，用例从 Go 端 server/data_test.go 平移：
// TestLoadStudentsDedup（姓名归一化后同一人只留一条）、
// TestLoadStudentsDedupAcrossClassNotations（一班与 1班 同班号去重）、
// TestLoadStudentsBOMStripped（BOM 剥离）、TestLoadStudentsTitleMismatch
//（新格式下改为结构守门：缺少学校数组）、TestLoadStudentsBadClassKey
//（班级格式异常）、TestLoadStudentsRejectsNullRoster（新格式下改为空校名）、
// TestLoadStudentsRejectsEmptyStudentName（空姓名）、TestErrNoRosterMessage
//（空目录运维指引逐字），并补齐空年级名、空班名、跨文件校名重复、
//「加载序 → SchoolIdx → 学校下拉」的端到端一条，以及修复轮 1 新增的
// 字段类型三态（Go 的 cannot unmarshal 族）、加载态失败后不可复用契约、
// 空白剥除与 String.prototype.trim 的分离点。
//
// 错误文案一律逐字断言而非子串：运维靠这句文案判断该去看哪一份文件的哪一层，
// 文案漂移等于排障指引失效，而子串断言对「多一个字、换一种括号」结构性失明。
// 为此本文件用 thrownMessage 取出实际文案再 toBe 比较，不用 toThrow(字符串)
//（后者是子串匹配）。
import { describe, expect, it } from "vitest";
import { schoolList } from "../worker/schools";
import { trimGoSpace } from "./classparse";
import { gradeValues, type Grade } from "./grades";
import {
  errNoRosterMessage,
  newRosterLoadState,
  parseRosterDocument,
  parseSingleDocument,
} from "./roster";

// 未识别年段在运行时的取值：加载期未匹配到声明年段时原样保留年级名。
// 类型断言集中在此一处，其余用例一律不越过类型边界。
const unknownGrade = "一年级" as unknown as Grade;

// thrownMessage 取出成功路径之外的错误文案。用取值后逐字比较而不是
// toThrow(字符串)：后者的字符串形态是子串匹配，与本文件「文案逐字」的目的相反。
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("期望抛错，实际正常返回");
}

// 单校单年级多班的文档构造：把「哪个字段被破坏」交给参数表达，
// 空校名/空年级名/空班名直接把空串传进来即可，不必为每格手抄一份 JSON。
// 用 JSON.stringify 而不是字符串拼接：转义由序列化器负责，fixture 不会因为
// 引号写错而变成「解析失败」用例，掩盖真正要测的分支。
interface SchoolSpec {
  校名: string;
  年级名: string;
  班级: Array<[班名: string, 姓名: string[]]>;
}

function documentJson(schools: SchoolSpec[]): string {
  return JSON.stringify({
    区县: "福清市",
    学校: schools.map((school) => ({
      校名: school.校名,
      年级: [
        {
          年级名: school.年级名,
          班级: school.班级.map(([班名, 姓名]) => ({
            班名,
            学生: 姓名.map((name) => ({ 姓名: name })),
          })),
        },
      ],
    })),
  });
}

// 合法最小文档，用于「守门不得误伤正常数据」的反向断言与派生字段断言。
function validDoc(): string {
  return documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["1班", ["张三"]]] }]);
}

describe("parseRosterDocument 层级解析与派生字段", () => {
  it("解析 区县/学校/年级/班级/学生 层级并填充派生字段", () => {
    const students = parseSingleDocument(
      documentJson([
        { 校名: "福清一中", 年级名: "高一", 班级: [["18班", ["张三", "李四"]]] },
        { 校名: "福清二中", 年级名: "高二", 班级: [["2班", ["王五"]]] },
      ]),
      "高一.json",
    );
    expect(students).toHaveLength(3);

    // 基础字段原样透传，派生字段由构造入口填充：schoolIdx 按学校首次出现序
    // 从 0 起，gradeIdx 按声明序（高一 = 0，高二 = 1）。
    expect(students[0].name).toBe("张三");
    expect(students[0].school).toBe("福清一中");
    expect(students[0].grade).toBe("高一");
    expect(students[0].className).toBe("18班");
    expect(students[0].classNo).toBe(18);
    expect(students[0].gradeIdx).toBe(0);
    expect(students[0].schoolIdx).toBe(0);
    // nameKey 正常姓名即原名（无空白、无大小写差异）
    expect(students[0].nameKey).toBe("张三");

    // 同校同班同年级的学生共享 schoolIdx / gradeIdx / classNo
    expect(students[1].schoolIdx).toBe(0);
    expect(students[1].gradeIdx).toBe(0);
    expect(students[1].classNo).toBe(18);
    expect(students[2].school).toBe("福清二中");
    expect(students[2].schoolIdx).toBe(1);
    expect(students[2].gradeIdx).toBe(1);
  });

  it("未识别年段映射为 gradeIdx === gradeValues.length，grade 保留原始串", () => {
    // 小学年段不在 gradeValues 内，schoolList 的「小学不入下拉」边界正是靠这个
    // 越界值判定。这里断言加载器确实产出了该形状，而不是把它归成某个高中生年段。
    const students = parseSingleDocument(
      documentJson([{ 校名: "某小学", 年级名: "一年级", 班级: [["一班", ["小明"]]] }]),
      "一年级.json",
    );
    expect(students).toHaveLength(1);
    expect(students[0].grade).toBe(unknownGrade);
    expect(students[0].gradeIdx).toBe(gradeValues.length);
  });

  it("剥离开头的 BOM（U+FEFF）后正常解析", () => {
    // 与 Go 的 bytes.TrimPrefix(payload, {0xEF,0xBB,0xBF}) 同义：只剥开头一个。
    const students = parseSingleDocument("\uFEFF" + validDoc(), "高一.json");
    expect(students).toHaveLength(1);
    expect(students[0].name).toBe("张三");
  });

  it("校名为 U+FEFF 时放行：Go 的 TrimSpace 不剥它，JS 的 trim 会剥", () => {
    // 这是 trimGoSpace 与 String.prototype.trim 的真实分离点，两端必须一致地放行：
    // Go 的 strings.TrimSpace 不认 U+FEFF（自 Unicode 4.0.1 起不在 White_Space 内），
    // 因此 "\uFEFF" 非空、是有校名的一侧；JS 的 trim 会把它剥成空串、报「缺少校名」。
    // 实现若误用 .trim()，本用例立刻翻红。
    const students = parseSingleDocument(
      documentJson([{ 校名: "\uFEFF", 年级名: "高一", 班级: [["1班", ["张三"]]] }]),
      "高一.json",
    );
    expect(students).toHaveLength(1);
    expect(students[0].school).toBe("\uFEFF");

    // 分离点本身也锁住：不去断言具体正则，只断言两者结果不同。
    expect(trimGoSpace("\uFEFF x")).not.toBe("\uFEFF x".trim());
    // 而 Go 空白集合内的字符两边都剥，保证 trimGoSpace 不是「什么都不剥」。
    expect(trimGoSpace("  x  ")).toBe("x");
  });
});

describe("parseRosterDocument 结构守门", () => {
  it("缺少学校数据（学校缺失或为空数组）整份拒绝并点名文件", () => {
    // 对应 Go 端 TestLoadStudentsTitleMismatch 的结构守门部分。
    // 空对象（连 学校 键都没有）与「学校:[]」同义：都不是 roster 格式。
    const missing = thrownMessage(() => parseSingleDocument("{}", "高一.json"));
    expect(missing).toBe("高一.json 缺少学校数据（不是 roster 格式）");

    const empty = thrownMessage(() => parseSingleDocument(`{"区县":"福清市","学校":[]}`, "高二.json"));
    expect(empty).toBe("高二.json 缺少学校数据（不是 roster 格式）");

    // 反向：合法 roster 不得被这条守门误伤。
    expect(parseSingleDocument(validDoc(), "ok.json")).toHaveLength(1);
  });

  it("空校名整份拒绝，否则会出现无归属的学生", () => {
    const message = thrownMessage(() =>
      parseSingleDocument(
        documentJson([{ 校名: "", 年级名: "高一", 班级: [["1班", ["张三"]]] }]),
        "高一.json",
      ),
    );
    expect(message).toBe("高一.json 存在缺少校名的学校记录");
    // 反向：正常校名不被误伤
    expect(parseSingleDocument(validDoc(), "高一.json")).toHaveLength(1);
  });

  it("空（或纯空白）年级名整份拒绝，并点名文件与学校", () => {
    // 校名/年级名/班名都走 Go 的 strings.TrimSpace 语义，纯空白与空串同判。
    // 纯空白这一格是 Go 侧「只判 == ""」与 TS 侧实现最容易分叉的地方。
    const message = thrownMessage(() =>
      parseSingleDocument(
        documentJson([{ 校名: "福清一中", 年级名: "  ", 班级: [["1班", ["张三"]]] }]),
        "高一.json",
      ),
    );
    expect(message).toBe("高一.json / 福清一中 存在缺少年级名的年级记录");
  });

  it("空班名整份拒绝，并点名文件、学校与年级", () => {
    const message = thrownMessage(() =>
      parseSingleDocument(
        documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["", ["张三"]]] }]),
        "高一.json",
      ),
    );
    expect(message).toBe("高一.json / 福清一中 / 高一 存在缺少班名的班级记录");
  });

  it("无法解析为班号的班名报班级格式异常（0班）", () => {
    // parseClassName 对「0」判非法而不是溢出：班级域不存在 0 班，
    // 数据路径据此整份拒绝，避免「按班级筛选永远筛不出人」。
    const message = thrownMessage(() =>
      parseSingleDocument(
        documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["0班", ["张三"]]] }]),
        "高一.json",
      ),
    );
    expect(message).toBe("高一.json / 福清一中 / 高一 班级格式异常（0班）");

    // 反向：汉字数字班名是合法形态，不得被误判
    expect(
      parseSingleDocument(
        documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["十八班", ["张三"]]] }]),
        "高一.json",
      )[0].classNo,
    ).toBe(18);
  });

  it("空姓名整份拒绝，否则搜索结果里会出现一条无名氏", () => {
    const message = thrownMessage(() =>
      parseSingleDocument(
        documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["1班", [""]]] }]),
        "高一.json",
      ),
    );
    expect(message).toBe("高一.json / 福清一中 / 1班 学生记录格式异常");

    // 反向：正常姓名不被误伤
    expect(parseSingleDocument(validDoc(), "高一.json")).toHaveLength(1);
  });

  it("非法 JSON 报解析失败并点名文件", () => {
    // Go 端用 %w 带上底层解析错误，TS 侧同形：文案前缀逐字，细节随后。
    const message = thrownMessage(() => parseSingleDocument("{broken", "高一.json"));
    expect(message.startsWith("解析 高一.json 失败: ")).toBe(true);
  });

  it("同一文件内校名重复整份拒绝", () => {
    // 对应 Go 的 schoolOrder 重复判定。括号是全角「（）」，与 Go 的 %s（%s）逐字一致。
    const duplicated = JSON.stringify({
      区县: "福清市",
      学校: [
        { 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "1班", 学生: [{ 姓名: "张三" }] }] }] },
        { 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "2班", 学生: [{ 姓名: "李四" }] }] }] },
      ],
    });
    const message = thrownMessage(() => parseSingleDocument(duplicated, "高一.json"));
    expect(message).toBe("校名重复: 福清一中（高一.json）");
  });

  it("跨文件校名重复整份拒绝：校名唯一性由加载态承接", () => {
    // Go 端 loadStudents 在一次调用里遍历整个目录，schoolOrder 与 nextSchool
    // 都是循环外的同一份状态。单文件纯函数要保留「校名唯一」与「SchoolIdx 连续」
    // 两条语义，必须由调用方把上一份文件结束时的状态递进来。
    const state = newRosterLoadState();
    expect(parseRosterDocument(validDoc(), "高一.json", state)).toHaveLength(1);

    const message = thrownMessage(() => parseRosterDocument(validDoc(), "高二.json", state));
    expect(message).toBe("校名重复: 福清一中（高二.json）");
  });
});

// 字段类型三态（修复轮 1，C1）：字段缺失/为 null 走零值（与 Go 一致），
// 存在但类型不对整份报「解析 失败」，类型正确则正常通过。
//
// 这一组用例的存在理由：旧实现把「类型不对」也换成空串/空数组，于是
// {"年级":"高一"} 被静默当成「没有年级」——产出空名单、服务正常启动对外报
// 「没有学生」，正是「把放错文件伪装成这所学校没有学生」的同一种病。
// Go 对同一输入是解析失败，两种出口的差异意味着运维在两端看到完全不同的结论。
//
// 断言用前缀 + 类型词：详细文案里带 JSON 路径（Go 的 struct field 名在 TS 侧
// 不存在），前缀 `解析 X 失败: json: cannot unmarshal <kind> into` 与 Go 同族。
describe("parseRosterDocument 字段类型不匹配 fail-closed", () => {
  // 取出失败文案并断言「解析失败族 + 具体类型词」。
  function expectTypeFailure(payload: string, sourceName: string, kind: string, pathHint: string): void {
    const message = thrownMessage(() => parseSingleDocument(payload, sourceName));
    expect(message.startsWith(`解析 ${sourceName} 失败: json: cannot unmarshal ${kind}`)).toBe(true);
    expect(message).toContain(pathHint);
  }

  it("年级是字符串 → 解析失败（Go: cannot unmarshal string into []sourceGrade）", () => {
    expectTypeFailure(
      JSON.stringify({ 学校: [{ 校名: "福清一中", 年级: "高一" }] }),
      "高一.json",
      "string",
      "学校[0].年级",
    );
  });

  it("班级是对象 → 解析失败（Go: cannot unmarshal object into []sourceClass）", () => {
    expectTypeFailure(
      JSON.stringify({ 学校: [{ 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: { 班名: "1班" } }] }] }),
      "高一.json",
      "object",
      "学校[0].年级[0].班级",
    );
  });

  it("学生是字符串 → 解析失败（Go: cannot unmarshal string into []sourceStudent）", () => {
    expectTypeFailure(
      JSON.stringify({
        学校: [{ 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "1班", 学生: "张三" }] }] }],
      }),
      "高一.json",
      "string",
      "班级[0].学生",
    );
  });

  it("姓名是数字 → 解析失败（Go: cannot unmarshal number into string）", () => {
    expectTypeFailure(
      JSON.stringify({
        学校: [
          { 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "1班", 学生: [{ 姓名: 123 }] }] }] },
        ],
      }),
      "高一.json",
      "number",
      "学生[0].姓名",
    );
  });

  it("校名是数字 → 解析失败（Go: cannot unmarshal number into string）", () => {
    expectTypeFailure(
      JSON.stringify({ 学校: [{ 校名: 55, 年级: [] }] }),
      "高一.json",
      "number",
      "学校[0].校名",
    );
  });

  it("学校是对象、顶层是数组、顶层是数字 → 解析失败", () => {
    expectTypeFailure(JSON.stringify({ 学校: {} }), "高一.json", "object", "RosterDocument.学校");
    expectTypeFailure(JSON.stringify([]), "高一.json", "array", "RosterDocument");
    expectTypeFailure("123", "高一.json", "number", "RosterDocument");
  });

  it("字段缺失或为 null 走零值，与 Go 一致（不报解析失败）", () => {
    // 三态的另一侧：null 与缺失同义，是 Go 的零值语义。
    // 姓名:null → 空串 → 「学生记录格式异常」（两端一致）。
    const nullName = thrownMessage(() =>
      parseSingleDocument(
        JSON.stringify({
          学校: [{ 校名: "福清一中", 年级: [{ 年级名: "高一", 班级: [{ 班名: "1班", 学生: [{ 姓名: null }] }] }] }],
        }),
        "高一.json",
      ),
    );
    expect(nullName).toBe("高一.json / 福清一中 / 1班 学生记录格式异常");

    // 学校元素为 null → 零值学校 → 空校名文案（与 Go 的 sourceSchool{} 同落点）。
    const nullSchool = thrownMessage(() =>
      parseSingleDocument(JSON.stringify({ 学校: [null] }), "高一.json"),
    );
    expect(nullSchool).toBe("高一.json 存在缺少校名的学校记录");

    // 顶层 null → 零值文档 → 缺少学校数据。
    const nullDoc = thrownMessage(() => parseSingleDocument("null", "高一.json"));
    expect(nullDoc).toBe("高一.json 缺少学校数据（不是 roster 格式）");

    // 缺 年级 的学校与 年级:[] 同义：零名学生、不报错。
    expect(parseSingleDocument(JSON.stringify({ 学校: [{ 校名: "福清一中" }] }), "高一.json")).toEqual([]);
  });

  it("类型错误优先于语义错误：与 Go 的两阶段顺序一致", () => {
    // Go 先整份 unmarshal 再做语义校验，因此「前面空校名、后面类型错误」报解析失败。
    // 就地判类型的实现会先撞上空校名，本用例锁住两阶段的顺序。
    const message = thrownMessage(() =>
      parseSingleDocument(
        JSON.stringify({
          学校: [
            { 校名: "", 年级: [] },
            { 校名: "福清二中", 年级: "高二" },
          ],
        }),
        "高一.json",
      ),
    );
    expect(message.startsWith("解析 高一.json 失败: ")).toBe(true);
  });
});

describe("parseRosterDocument 去重键", () => {
  it("「一班」与「1班」是同一个班：同班号的同一人只加载一条", () => {
    // 两种写法混用时，去重键若用原始班名，同一个人会被加载两次并在响应里出现
    // 两条班名不同的记录。断言只锁条数与班号，不锁幸存的班名——与 Go 端同理由：
    // 幸存的写法由加载顺序决定，写进断言会造出对顺序敏感的偶发失败。
    const students = parseSingleDocument(
      documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["1班", ["张三"]], ["一班", ["张三"]]] }]),
      "高一.json",
    );
    expect(students).toHaveLength(1);
    expect(students[0].classNo).toBe(1);
  });

  it("姓名归一化后相同（「张 三」与「张三」）只加载一条", () => {
    const students = parseSingleDocument(
      documentJson([{ 校名: "福清一中", 年级名: "高一", 班级: [["1班", ["张三", "张 三", "王五"]]] }]),
      "高一.json",
    );
    expect(students.map((student) => student.name)).toEqual(["张三", "王五"]);
  });

  it("同名同班号但不同学校不去重：去重键含学校", () => {
    // 键漏掉学校时，两所学校的同名同班学生会互吞，其中一所的学生凭空消失。
    const students = parseSingleDocument(
      documentJson([
        { 校名: "福清一中", 年级名: "高一", 班级: [["1班", ["张三"]]] },
        { 校名: "福清二中", 年级名: "高一", 班级: [["1班", ["张三"]]] },
      ]),
      "高一.json",
    );
    expect(students).toHaveLength(2);
    expect(students.map((student) => student.school)).toEqual(["福清一中", "福清二中"]);
  });
});

// 加载态契约（修复轮 1，I2）：失败后残留的校名占位会让「同一份修好的文件」
// 在重试时报「校名重复」。Go 每次加载从零建两张表，因此不暴露这一点；
// TS 侧状态是调用方持有的，必须在文档与测试上把「失败后换新态」写死。
describe("RosterLoadState 失败后不可复用", () => {
  it("失败后残留占位：旧态重试报校名重复，换新态成功", () => {
    // 第一份在年级层失败：校名已占位（nextSchool 已自增），学生未产出。
    const stale = newRosterLoadState();
    const broken = thrownMessage(() =>
      parseRosterDocument(
        JSON.stringify({ 学校: [{ 校名: "福清一中", 年级: [{ 年级名: "" }] }] }),
        "坏.json",
        stale,
      ),
    );
    expect(broken).toBe("坏.json / 福清一中 存在缺少年级名的年级记录");

    // 残留状态确实被写入：这正是「不可复用」的原因，而不是空泛的告诫。
    expect(stale.nextSchool).toBe(1);
    expect(stale.schoolOrder.has("福清一中")).toBe(true);

    // 旧态重试同一份修好的文件：校名占位还在，报重复——契约的另一侧。
    const retried = thrownMessage(() => parseRosterDocument(validDoc(), "修好.json", stale));
    expect(retried).toBe("校名重复: 福清一中（修好.json）");

    // 换新态：成功加载，且 SchoolIdx 从 0 重新开始。
    const fresh = newRosterLoadState();
    const students = parseRosterDocument(validDoc(), "修好.json", fresh);
    expect(students).toHaveLength(1);
    expect(students[0].schoolIdx).toBe(0);
  });
});

describe("加载序 → SchoolIdx → 学校下拉 端到端", () => {
  it("多次调用模拟多文件：SchoolIdx 单调递增，下拉只含高中校且按文件加载序", () => {
    // 这条用例承接 Task 7 评审的两条上游约束：
    //   1) 未识别年段必须映射为 gradeIdx === gradeValues.length，否则小学边界失效；
    //   2) SchoolIdx 必须单调递增且与校名一一对应，schoolList 的排序正确性依赖它。
    // 端到端串起「加载态 → 学生快照 → 下拉」，使这两条不再只有 Go 侧守。
    // state 显式传入且跨两次调用共用：漏传是编译错误，不会静默失效。
    const state = newRosterLoadState();

    // 第一份文件：两所学校，第二所是只有小学年段的学校（其学生仍可被搜索命中）
    const first = parseRosterDocument(
      documentJson([
        { 校名: "福清一中", 年级名: "高一", 班级: [["1班", ["张三"]]] },
        { 校名: "某小学", 年级名: "一年级", 班级: [["一班", ["小明"]]] },
      ]),
      "高一.json",
      state,
    );
    // 第二份文件：SchoolIdx 必须接续第一份的 nextSchool，而不是复位到 0
    const second = parseRosterDocument(
      documentJson([{ 校名: "福清二中", 年级名: "高二", 班级: [["2班", ["李四"]]] }]),
      "高二.json",
      state,
    );

    expect(first.map((student) => student.schoolIdx)).toEqual([0, 1]);
    // 若第二份文件重置 nextSchool，这里会得到 0 而不是 2，本断言直接翻红
    expect(second.map((student) => student.schoolIdx)).toEqual([2]);

    const students = [...first, ...second];
    expect(students).toHaveLength(3);
    // 小学学生确实被加载了（仍可被全局搜索命中），只是不进下拉
    expect(students[1].gradeIdx).toBe(gradeValues.length);
    expect(students[1].school).toBe("某小学");

    // 下拉：只含两所高中校，且顺序 = 文件加载序（不是校名字典序，也不是首现序巧合）
    expect(schoolList(students)).toEqual(["福清一中", "福清二中"]);
  });
});

describe("errNoRosterMessage", () => {
  it("空名单运维指引逐字不变", () => {
    // 与 Go 端 errNoRoster 的文案逐字一致：云端语义由 rosterStore 承接为
    // 「KV 里没有任何 roster」，指引仍指向放入 roster JSON 这一动作。
    expect(errNoRosterMessage()).toBe(
      "数据文件缺失，请将 roster JSON（区县/学校/年级/班级/学生 结构）放入数据目录",
    );
  });
});
