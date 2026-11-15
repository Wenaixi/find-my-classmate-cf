// 班级解析的单一 owner：班级名 → 班号这一领域概念的所有事实与实现集中于此。
// Go 端 classparse.go（数据侧校验）与前端 lib/query.ts（查询侧解释）此前各持
// 一份镜像，本文件合并两者并统一导出。query.ts（现于 shared 目录）从本文件
// 取值，消费方不再持有第二份声明。
//
// 三条跨语言不变量由实现强制而非注释承诺：
// - Valid ⇒ ClassNo > 0：Atoi（Number）成功得到 0 在班级域不存在，属非法而非
//   溢出；overflow 仅指「全数字但超出范围」；
// - 无法解析与溢出都必须降级为姓名条件（classCondition 收敛），绝不丢弃 token，
//   丢弃会让全部条件落空、Search 退化成与用户输入无关的全校检索；
// - 年级可解析而班级不可解析时，保留年级条件并把整个 token 按姓名处理。
//   （本文件承担「整个 token 按姓名处理」：classCondition 以 rawToken 为降级
//   匹配键；「保留年级条件」由连写调用点在消费侧落实，与本文件无关。）
//
// 本文件不依赖 grades.ts：班级解析与年段值域是两个独立领域，方向保持单向。

// 汉字数字的单字符集是班级域的跨语言契约：本文件的全部用途——正则字符类、
// 连写守门、值映射——都由下方 chineseDigitOnes 派生，不得手抄第二份字符集。
// 两端此前共六份手抄（Go 端三处、TS 端三处）。第十八轮变异实验实测：把两端
// classNumberHead 同时删掉「四」与「七」，Go 全量测试与前端 194 条契约对拍
// 全部零翻红——语料与对拍在结构上表达不出「两端一致地错」，而守门收窄会让
// 「高一四班」从「高一 + 4 班」退化为整年段全量返回。单一 owner 使此类分叉
// 的载体不复存在，剩余防御是下方契约用例。
//
// 「十」单独处理而非并入：它的值是 10 而不是位置即值，而 chineseDigitOnes
// 的顺序恰好是值序（index+1），两者不能共用一条推导。
export const chineseDigitOnes = "一二三四五六七八九";
const chineseOnesClass = "[" + chineseDigitOnes + "]";

// classDigits 是汉字数字到班号的真值表，与 chineseDigitOnes 同源派生：派生
// 而非手写，使值表与两处正则无法分叉（漏字结构性不可能——表由字符串生成）。
// 「十」不在 chineseDigitOnes 里（它的值不是位置即值），单独补入。
// Go 端同一张表踩过字节偏移坑（range 的 i 按字节计，中文占三字节，按 i+1
// 赋值得到「四:10」「五:13」）；TS 端用展开按码点取序号，不存在该陷阱，
// 此坑只记录不复制。表的键类型必须是可索引的宽类型（Record<string, number>），
// 因为解析按运行时字符串查表。
const classDigitEntries = [
  ...[...chineseDigitOnes].map((digit, index) => [digit, index + 1] as const),
  ["十", 10] as const,
] as const;
const classDigits: Record<string, number> = Object.fromEntries(classDigitEntries);

// 汉字数字班号的合法形态精确为三种：单字、十开头、第二字为十。
// 这段正则的接受域必须与下方解析器（chineseNumberToInt）的接受域一致：
// 此前写 [一二三四五六七八九十]+ 贪婪匹配任意长度，而解析器只认三种形态，
// 于是「匹配成功却被静默截断」——「九十九十九」取前三位得 99、「十十」得 20、
// 「二十一十」得 21，且都声称解析成功。畸形班名因此被当成合法班号；
// 超长输入应在匹配阶段就落选，不得进入解析器静默截断。
const chineseNumberPattern = chineseOnesClass + "|十" + chineseOnesClass + "?|" + chineseOnesClass + "十" + chineseOnesClass + "?";

// classNumberPattern 是完整班号：阿拉伯数字（任意长度，是否溢出由解析层判定）
// 或汉字数字。字符类由 chineseDigitOnes 派生而不是手写：手写副本曾与
// classNumberHead 的字符集分叉（后者漏字无从发现，因为两端可同时漏）。
export const classNumberPattern = "[0-9]+|" + chineseNumberPattern;

// classToken 整段匹配「班号 + 可选的班字」，查询侧的纯班级判定用它。
export const classToken = new RegExp(`^(${classNumberPattern})班?$`);

// classHeadChars 是 classNumberHead 的字符集：阿拉伯数字加十个汉字数字。
// 单独提出为常量，使跨语言对拍能直接锁它——锁整个正则会被 "^" 与字符类的
// 包装形式干扰，而真正需要两端一致的是这串字符。
export const classHeadChars = "[0-9" + chineseDigitOnes + "十]";

// classNumberHead 只判「以班号字符开头」，不判整段可解析：年级+班级连写
// 用它守门，「高一同学」开头不是班号字符（是姓名），而「一一」开头是班号
// 字符却解析失败——后者必须放行到 classCondition 降级路径，整段匹配
// （classToken）会把「一一」一并挡在降级路径之外。
// 字符集与 chineseDigitOnes 同源派生：它曾零对拍且收窄即致整年段全量，
// 现已无法与 chineseNumberPattern 分叉。
export const classNumberHead = new RegExp("^" + classHeadChars);

// chineseNumberToInt 解析汉字数字（支持一~九十九 与 十~十九），返回前端域：
// 号码或 0。Go 端同函数的 (int, bool) 双返回值（bool 报告解析是否成功）由
// parseClassName 承接——本函数的调用点都在 classToken 整段匹配成功之后，
// 正则已把形态限制在三种合法形态内，此处的 0 只在「值表未命中」时出现，
// 由调用点按非法处理。形如「十零」的串通不过正则，不会到达本函数；
// 本函数不单独承担形态判定，与 Go 端 chineseNumberToInt 由 classToken 守门
// 是同一条分工。
export function chineseNumberToInt(value: string): number {
  if (!value) return 0;
  const runes = [...value];
  if (runes[0] === "十") {
    // 十/十一：以十开头，十位记 1，个位查表（可缺省）。
    return 10 + (runes.length > 1 ? (classDigits[runes[1]] ?? 0) : 0);
  }
  if (runes.length >= 2 && runes[1] === "十") {
    // 二十/二十一：十位 * 10 + 个位；个位查表失败按 0 处理由调用点兜底。
    const tens = classDigits[runes[0]] ?? 0;
    const ones = runes.length > 2 ? (classDigits[runes[2]] ?? 0) : 0;
    return tens > 0 ? tens * 10 + ones : 0;
  }
  // 单字一~九：查表未命中说明不是合法汉字数字，返回 0 由调用点判非法。
  return classDigits[value] ?? 0;
}

// 班级判定的显式三态，与 Go 端 ClassParseResult 同形：非法与溢出在类型上
// 可区分，调用方不必靠「两个值恰好同行为」推断它没漏判。两端对二者同策略
// （都按姓名处理），三态化的收益在类型层而非行为层。
export type ClassNumberResult =
  | { ok: true; classNo: number }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "overflow" };

// 空白集合与姓名归一化的单一 owner 在本文件：goSpaceChars 是两个方向差集的
// 唯一修正点，三处用途（分词切分 goSpaceSplit、匹配键删空白 goSpace、首尾剥除
// goSpaceTrim）全部由它派生，不得手抄第二份。
//
// 集合逐码位枚举 Go 的 unicode.IsSpace 而不用 JS 的 \s 近似：两者的差集有两个
// 码位且方向相反——U+0085（NEL）是 Go 的空白而 \s 不含，U+FEFF 自 Unicode 4.0.1
// 起不在 White_Space 内、Go 不认而 \s 认。用 \s 会在 U+FEFF 上静默与 Go 分叉：
// 查询分词被切开、姓名匹配键被删除。query.ts 的 tokenize 取 goSpaceSplit，
// normalizeName 由本文件导出后再经 query.ts re-export，两处都不持有副本。
const goSpaceChars = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const goSpace = new RegExp("[" + goSpaceChars + "]", "g");
const goSpaceTrim = new RegExp("^[" + goSpaceChars + "]+|[" + goSpaceChars + "]+$", "g");

// goSpaceSplit 是查询分词的切分正则，与 Go 端 strings.Fields 的切分集合对齐。
// 不导出字符集本身：消费方只该拿到「怎么切」，字符集与它的理由留在本文件。
export const goSpaceSplit = new RegExp("[" + goSpaceChars + "]+");

// normalizeName 是姓名降级的匹配键归一化：删除 Go 空白集合，再统一大写
// （toUpperCase 与 Go strings.ToUpper 同为 locale 无关；toLocaleUpperCase
// 随宿主 locale 变化，tr/az 下 "i" 映射为 U+0130）。
export function normalizeName(value: string): string {
  return value.replace(goSpace, "").toUpperCase();
}

// isAllDigits 判定字符串是否全为阿拉伯数字，与 Go 端逐码位语义一致（空串
// 返回 false）。parseClassName 用它区分「全数字但超出范围」的溢出与「包含
// 非数字字符」的格式非法。逐码位比较而非 /\d+$/：JS 不加 /u 的 \d 与
// ASCII 数字等价，但显式逐码位与 Go 端逐 rune 比较同一份语义，无需依赖
// 正则标记的隐式行为。
export function isAllDigits(value: string): boolean {
  if (value === "") return false;
  for (const rune of value) {
    if (rune < "0" || rune > "9") return false;
  }
  return true;
}

// parseClassName 解析班级名为三态结果：合法（含班号）/ 非法格式 / 数字溢出。
// 与 Go 端 classparse.go 同名同语义，是 Go 版 (int, bool) 语义在 TS 侧的
// 承接者。溢出只指格式合法（全数字）但超出范围（前端以 Number.isSafeInteger
// 表达「超出范围」，Go 端以 int 的 Atoi 越界表达同一含义，契约样本远大于
// 两者边界，行为一致）；由数据路径拒绝、查询路径按姓名处理。
export function parseClassName(value: string): { classNo: number; valid: boolean; overflow: boolean } {
  // 与 Go 端 strings.TrimSpace 对齐：只剥「Go 空白集合」（goSpaceTrim），
  // U+FEFF 不在该集合内故不剥除，与 Go 一致。
  const match = value.replace(goSpaceTrim, "").match(classToken);
  if (!match) return { classNo: 0, valid: false, overflow: false };
  const digits = match[1];
  if (isAllDigits(digits)) {
    const number = Number(digits);
    if (Number.isSafeInteger(number)) {
      // Atoi 成功即证明这是格式合法的数字，因此不可能是溢出。
      // 班号必须为正：「0」语法上是合法数字（转换成功且无错），但班级域
      // 里不存在 0 班。此处若把 0 包成合法（Valid=true）或谎报溢出，都违背
      // 「Valid ⇒ ClassNo > 0」不变量——旧实现曾把 0 包成 Valid=true，下游
      // classCondition 因此既不产生班级条件也不降级为姓名条件，与年级连写
      // 时（「高一0班」）条件落空，Search 退化为整年段全量返回。
      // 不变量必须由实现强制，不能只写在注释里：0 属非法而非溢出，
      // 两种语义不可混同（0 装得下，不是「超出范围」）。
      if (number > 0) return { classNo: number, valid: true, overflow: false };
      return { classNo: 0, valid: false, overflow: false };
    }
    // 数字溢出：格式合法（全数字）但超出范围，交由调用方按姓名处理。
    return { classNo: 0, valid: false, overflow: true };
  }
  const classNo = chineseNumberToInt(digits);
  if (classNo > 0) return { classNo, valid: true, overflow: false };
  // 汉字数字无法解析：格式非法而非溢出，交由调用方按非法处理。
  return { classNo: 0, valid: false, overflow: false };
}

// classNumber 是 parseClassName 的薄封装：解析判定完全同源（含剥除空白、
// 0 属非法、溢出判定），本函数只做返回形状的翻译——ClassNumberResult 的
// 三态联合（ok / invalid / overflow）对应 parseClassName 的三个字段
// （classNo / valid / overflow）。两函数唯一的差异是形状，不是行为：
// 同一输入在两函数下的判定必然一致，ok:true 时班号恒为正。
export function classNumber(value: string): ClassNumberResult {
  const parsed = parseClassName(value);
  if (parsed.valid) return { ok: true, classNo: parsed.classNo };
  return parsed.overflow ? { ok: false, reason: "overflow" } : { ok: false, reason: "invalid" };
}

// classCondition 把一个班级片段解释为「已解释的条件片段」，降级策略与它的
// 理由收敛到本函数。此前 parseQuery 有四段近乎逐字重复的「追加 normalizeName;
// continue」，而解释为什么必须降级、不能静默丢弃的注释只写在其中一段——
// 其余三段靠「照抄旁边那段」维持这条安全不变量，改任一段时看不到理由，
// 容易被当成冗余代码清理掉。
//
// matchPart 是班级部分（用于判定班号），rawToken 是用户输入的整个 token
// （用于降级为姓名条件时的匹配键）。两者必须分开：查询「一一班」时班级部分
// 是「一一」，而降级后的姓名匹配键必须是「一一班」——用户输入的是后者。
//
// 不变量：无法解析（invalid）与数字溢出（overflow）都必须降级为姓名条件，
// 绝不丢弃 token。丢弃会让全部条件落空，Search 退化成与用户输入无关的
// 全校检索——这不是理论风险，v0.9.1 修复前输入「一一班」曾返回全校 1047 条。
// 溢出与无法解析同策略：两者都不是「合法班号」，都会让班级条件落空。
//
// 返回值约定（两条，无第三态）：classNo > 0 表示解析为班级条件，调用方应
// 设为班级条件；否则 asName 非空（rawToken 来自 tokenize，恒含至少一个
// 非空白字符），调用方把它追加到姓名条件。判定「是否为班级 token」由调用点
// 的守门承担（classToken 整段匹配与 classNumberHead 首字符匹配），不落在
// 本函数内。接缝复查：parseClassName 已强制 Valid ⇒ ClassNo > 0，此处仍
// 保有 > 0 守卫，与 Go 端 classCondition 接缝测试同一道防线。
export function classCondition(matchPart: string, rawToken: string): { classNo: number; asName: string } {
  const parsed = parseClassName(matchPart);
  if (parsed.valid && parsed.classNo > 0) {
    return { classNo: parsed.classNo, asName: "" };
  }
  // 降级：匹配键取 rawToken（用户原始输入）而非 matchPart——「降级时用哪个
  // 形态参与匹配」与「降级」本身是同一个决定，收在这里使调用方无法传错。
  return { classNo: 0, asName: normalizeName(rawToken) };
}