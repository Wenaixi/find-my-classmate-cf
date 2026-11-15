import { describe, expect, it } from "vitest";
import {
  chineseDigitOnes,
  chineseNumberToInt,
  classCondition,
  classHeadChars,
  classNumber,
  classNumberHead,
  classNumberPattern,
  classToken,
  isAllDigits,
  parseClassName,
} from "./classparse";
// 端到端证据用的连写入口：splitGradeClass 的 owner 在 shared/query.ts，
// 本文件经 query.ts 的 parseQuery 走完整链路，验证守门与降级在真实查询里的行为。
import { parseQuery } from "./query";

// 单一 owner 派生接线：正则字符类、守门字符集、值表都必须由 chineseDigitOnes
// 派生，手抄第二份字符集会在这组等值断言上翻红——结构上锁死「无法分叉」。
describe("字符集由 chineseDigitOnes 单一 owner 派生", () => {
  it("chineseDigitOnes 恰为值序的九个汉字单字符", () => {
    expect(chineseDigitOnes).toBe("一二三四五六七八九");
  });

  it("classNumberPattern 的汉字类由 chineseDigitOnes 派生", () => {
    const derived = "[0-9]+|[" + chineseDigitOnes + "]|十[" + chineseDigitOnes + "]?|[" + chineseDigitOnes + "]十[" + chineseDigitOnes + "]?";
    expect(classNumberPattern).toBe(derived);
  });

  it("classHeadChars 恰为阿拉伯数字加 chineseDigitOnes 与十", () => {
    expect(classHeadChars).toBe("[0-9" + chineseDigitOnes + "十]");
  });

  it("classToken 与 classNumberHead 由对应字符串构造", () => {
    expect(classToken.source).toBe("^(" + classNumberPattern + ")班?$");
    expect(classNumberHead.source).toBe("^" + classHeadChars);
  });
});

// classNumber 三态（前端版）：合法 / 非法 / 溢出，与 Go 端 ClassParseResult 同形。
describe("classNumber 三态", () => {
  it("阿拉伯数字合法", () => {
    expect(classNumber("18")).toEqual({ ok: true, classNo: 18 });
    expect(classNumber("18班")).toEqual({ ok: true, classNo: 18 });
  });

  it("汉字数字合法形态：单字 / 十开头 / 第二字为十", () => {
    expect(classNumber("十")).toEqual({ ok: true, classNo: 10 });
    expect(classNumber("十一")).toEqual({ ok: true, classNo: 11 });
    expect(classNumber("十二班")).toEqual({ ok: true, classNo: 12 });
    expect(classNumber("二十")).toEqual({ ok: true, classNo: 20 });
    expect(classNumber("二十一")).toEqual({ ok: true, classNo: 21 });
    expect(classNumber("二十二")).toEqual({ ok: true, classNo: 22 });
    expect(classNumber("三十三")).toEqual({ ok: true, classNo: 33 });
    expect(classNumber("九十九班")).toEqual({ ok: true, classNo: 99 });
  });

  it("非法形态判 invalid", () => {
    expect(classNumber("未知")).toEqual({ ok: false, reason: "invalid" });
    expect(classNumber("一一")).toEqual({ ok: false, reason: "invalid" });
    expect(classNumber("九九班")).toEqual({ ok: false, reason: "invalid" });
    expect(classNumber("九十九十九")).toEqual({ ok: false, reason: "invalid" });
    expect(classNumber("十十")).toEqual({ ok: false, reason: "invalid" });
  });

  it("数字溢出判 overflow", () => {
    expect(classNumber("99999999999999999999")).toEqual({ ok: false, reason: "overflow" });
    expect(classNumber("99999999999999999999班")).toEqual({ ok: false, reason: "overflow" });
  });

  // 不变量 1 的前端侧：Atoi（Number）成功得到 0 属非法——班级域不存在 0 班，
  // 不得谎报 overflow（overflow 仅指全数字但超出范围）。
  it("0 属非法而非溢出", () => {
    expect(classNumber("0")).toEqual({ ok: false, reason: "invalid" });
    expect(classNumber("0班")).toEqual({ ok: false, reason: "invalid" });
    expect(classNumber("00班")).toEqual({ ok: false, reason: "invalid" });
  });
});

// parseClassName 三态（Go 版）：合法 / 非法 / 溢出，parseClassName 是 Go 端
// (int, bool) 语义的承接者，Atoi 成功但 0 属非法而非溢出在此强制。
describe("parseClassName 三态", () => {
  it("合法班级解析出班号", () => {
    expect(parseClassName("18班")).toEqual({ classNo: 18, valid: true, overflow: false });
    expect(parseClassName("十班")).toEqual({ classNo: 10, valid: true, overflow: false });
    expect(parseClassName("十二班")).toEqual({ classNo: 12, valid: true, overflow: false });
  });

  it("非法格式判 invalid 且非 overflow", () => {
    expect(parseClassName("未知")).toEqual({ classNo: 0, valid: false, overflow: false });
    expect(parseClassName("一一班")).toEqual({ classNo: 0, valid: false, overflow: false });
    expect(parseClassName("九九班")).toEqual({ classNo: 0, valid: false, overflow: false });
  });

  it("数字溢出判 overflow", () => {
    expect(parseClassName("99999999999999999999")).toEqual({ classNo: 0, valid: false, overflow: true });
    expect(parseClassName("99999999999999999999班")).toEqual({ classNo: 0, valid: false, overflow: true });
  });

  // Go 端 TestZeroClassIsRejectedNotAccepted 的解析层：0 不是合法班号，也不是
  // 溢出（溢出指超出范围，装得下 0）。变异 B 的翻红锚点在此。
  it("0 属非法而非溢出：不谎报 overflow", () => {
    for (const className of ["0班", "0", "00班", "000班"]) {
      const got = parseClassName(className);
      expect(got.valid).toBe(false);
      expect(got.overflow).toBe(false);
    }
    // 正数班号不得被本次判定误伤。
    for (const [className, want] of Object.entries({ "1班": 1, "10班": 10, "18班": 18, "十班": 10 })) {
      const got = parseClassName(className);
      expect(got.valid).toBe(true);
      expect(got.classNo).toBe(want);
      expect(got.overflow).toBe(false);
    }
  });

  // parseClassName 对齐 Go 端 strings.TrimSpace：剥除首尾的 Go 空白集合，
  // U+FEFF 不是 Go 的空白（自 Unicode 4.0.1 起不在 White_Space 内），不得剥除。
  it("首尾空白按 Go 空白集合剥除", () => {
    expect(parseClassName(" 18班 ")).toEqual({ classNo: 18, valid: true, overflow: false });
    expect(parseClassName("\u300018\u3000")).toEqual({ classNo: 18, valid: true, overflow: false });
    expect(parseClassName("\uFEFF18班")).toEqual({ classNo: 0, valid: false, overflow: false });
  });
});

// 不变量锁：Valid 为真时班号必须为正。端口 Go 端
// TestParseClassNameValidImpliesPositiveClassNo：单字重复与非法十位组合
// 必须报非法（Valid=false）——只检查「Valid 时 ClassNo>0」恒真通过，
// 对「九十九十九」曾被静默截断为 99 的回归无从发现。
describe("parseClassName：Valid ⇒ ClassNo > 0", () => {
  it("单字重复与非法十位组合一律非法", () => {
    for (const className of ["一一班", "八八班", "零零班", "九十九十九班", "十十班", "二十一十班", "十十十班"]) {
      const got = parseClassName(className);
      expect(got.valid).toBe(false);
      if (got.valid) {
        expect(got.classNo).toBeGreaterThan(0);
      }
    }
  });
});

// 汉字数字的合法形态恰为三种：单字（一~九）、十开头（十/十一）、第二字为十
// （二十/二十一…九十九）。超过三字的串一律非法。逐形态枚举，防实现再次
// 退化为「只取前三位」——端口 Go 端 TestParseClassNameRejectsOverlongChineseNumbers。
describe("parseClassName 拒绝超长汉字数字", () => {
  it("超长与畸形形态逐条非法且非溢出", () => {
    for (const className of ["九十九十九班", "二十一十班", "十十班", "十十十班", "一二十二班", "一二三十班"]) {
      const got = parseClassName(className);
      expect(got.valid).toBe(false);
      expect(got.overflow).toBe(false);
    }
  });

  it("三字以内的合法形态仍然可用（防「只取前三位」）", () => {
    const legal: Record<string, number> = {
      一班: 1,
      十班: 10,
      十一班: 11,
      二十班: 20,
      二十一班: 21,
      九十九班: 99,
      二十二班: 22,
      三十三班: 33,
    };
    for (const [className, want] of Object.entries(legal)) {
      const got = parseClassName(className);
      expect(got.valid).toBe(true);
      expect(got.classNo).toBe(want);
      expect(got.overflow).toBe(false);
    }
  });
});

// chineseNumberToInt 返回前端域（号码或 0）；Go 版的 (int, bool) 双返回值
// 语义由 parseClassName 承接。形态判定（超长/畸形）由 classToken 的接受域
// 承担，本函数不单独判形态——「十零」这类串到不了这里。
describe("chineseNumberToInt（前端返回域）", () => {
  it("一~九十九 与 十~十九 逐值映射", () => {
    const cases: Record<string, number> = {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
      十一: 11,
      十二: 12,
      十九: 19,
      二十: 20,
      二十一: 21,
      二十二: 22,
      三十三: 33,
      九十九: 99,
    };
    for (const [value, want] of Object.entries(cases)) {
      expect(chineseNumberToInt(value)).toBe(want);
    }
  });

  it("空串与值表外字符返回 0", () => {
    expect(chineseNumberToInt("")).toBe(0);
    expect(chineseNumberToInt("未知")).toBe(0);
    expect(chineseNumberToInt("零")).toBe(0);
  });
});

// classCondition 是整个降级策略的单一收敛点：无法解析与溢出都必须降级为
// 姓名条件（asName），绝不丢弃 token。端口 Go 端 TestZeroClassIsRejectedNotAccepted
// 的降级侧，以及 classCondition 的接缝不变量。
describe("classCondition 降级收敛", () => {
  it("合法班级产出班级条件", () => {
    expect(classCondition("十八", "十八班")).toEqual({ classNo: 18, asName: "" });
  });

  it("无法解析降级为姓名条件且不丢 token", () => {
    const got = classCondition("一一", "一一班");
    expect(got.classNo).toBe(0);
    expect(got.asName).toBe("一一班");
  });

  it("溢出与无法解析同策略：按姓名处理", () => {
    const got = classCondition("99999999999999999999", "99999999999999999999班");
    expect(got.classNo).toBe(0);
    expect(got.asName).toBe("99999999999999999999班");
  });

  it("0 降级为姓名条件，token 不静默消失", () => {
    const got = classCondition("0", "0班");
    expect(got.classNo).toBe(0);
    expect(got.asName).toBe("0班");
  });

  // 归一化直断：上方降级用例的输入（「一一班」「0班」「999…班」）全无空白、
  // 无小写，normalizeName 的大写与删空白两个动作在那些断言上不可区分——
  // 误删其一仍全绿。本条用带小写与内部空白的输入直断「大写 + 删 Go 空白」。
  // 注意「abc 班」含英文，不是真实班级 token 形态，此处只为零散命名实体
  // 锁定归一化语义，不暗示其为合法班名（parseClassName 对它判非法）。
  it("降级匹配键经归一化：大写并删除 Go 空白集合", () => {
    const got = classCondition("abc 班", "abc 班");
    expect(got.classNo).toBe(0);
    expect(got.asName).toBe("ABC班");
  });

  // 对照：班级条件成立时 asName 必须为空——归一只在降级路径生效，
  // 合法班号不得被误归一化。
  it("班级条件成立时 asName 为空（归一化只在降级路径）", () => {
    const got = classCondition("十班", "十班");
    expect(got.classNo).toBe(10);
    expect(got.asName).toBe("");
  });

  // 接缝复查（端口 Go 端 TestValidImpliesPositiveClassNo 第 1 条）：
  // 降级路径已排除后，剩余路径产出的班号必须为正。
  it("降级排除后班号恒为正", () => {
    const inputs = ["1班", "18班", "十班", "六班", "九九班", "0班", "0", "00班", "未知", "99999999999999999999班"];
    for (const input of inputs) {
      const { classNo, asName } = classCondition(input, input);
      if (asName !== "") {
        expect(classNo).toBe(0);
      } else {
        expect(classNo).toBeGreaterThan(0);
      }
    }
  });
});

// classNumberHead 只判「以班号字符开头」，不判整段可解析：年级+班级连写
// 用它守门，「高一同学」开头不是班号字符（是姓名），而「一一」开头是班号
// 字符却解析失败——后者必须放行到降级路径。变异 A（字符集去掉「四」）的
// 翻红锚点在「四」的守门直断上。
describe("classNumberHead 守门：只判开头不判整段", () => {
  it("班号字符开头通过守门", () => {
    expect(classNumberHead.test("四")).toBe(true);
    expect(classNumberHead.test("四班")).toBe(true);
    expect(classNumberHead.test("一一")).toBe(true);
    expect(classNumberHead.test("22")).toBe(true);
  });

  it("非班号字符开头不通过守门", () => {
    expect(classNumberHead.test("同学")).toBe(false);
    expect(classNumberHead.test("高一同学")).toBe(false);
  });

  it("「一一」通过守门但整段解析失败：守门必须放行到降级路径", () => {
    expect(classNumberHead.test("一一")).toBe(true);
    expect(classNumber("一一")).toEqual({ ok: false, reason: "invalid" });
  });

  // 端到端证据：守门收窄（如字符集漏「四」）会让「高一四班」从「高一 + 4 班」
  // 退化为整年段全量返回。连写守门的实现虽然住在 query.ts 的 splitGradeClass，
  // 但守门字符集（classNumberHead）由本文件派生，本条经完整链路承重本文件变异。
  it("「高一四班」端到端解析为高一 4 班", () => {
    const parsed = parseQuery("高一四班");
    expect(parsed.grade).toBe("高一");
    expect(parsed.classNumber).toBe(4);
    expect(parsed.nameTokens).toEqual([]);
  });
});

describe("isAllDigits", () => {
  it("全阿拉伯数字为 true，与是否溢出无关", () => {
    expect(isAllDigits("18")).toBe(true);
    expect(isAllDigits("0")).toBe(true);
    expect(isAllDigits("99999999999999999999")).toBe(true);
  });

  it("空串为 false", () => {
    expect(isAllDigits("")).toBe(false);
  });

  it("含非数字字符为 false", () => {
    expect(isAllDigits("18班")).toBe(false);
    expect(isAllDigits("1a")).toBe(false);
    expect(isAllDigits(" 1")).toBe(false);
  });
});