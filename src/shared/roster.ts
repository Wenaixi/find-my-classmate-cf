// 名单加载守门的单一 owner：把 Go 端 server/data.go 的 loadStudents 对
// **单份 roster 文件**的校验语义平移为纯函数。目录遍历（文件名排序、后缀筛选、
// 空目录守卫、热重载与失败冷却）不在本文件职责内，由后续 rosterStore 承接；
// 本文件只管「一份 JSON 原文 → 学生快照」，或整份拒绝。
//
// 错误文案与 Go 逐字一致，这是本文件的硬约束：运维靠这句话判断该去看哪一份
// 文件的哪一层。文案里带 来源名 / 校名 / 年级名 / 班名，逐层收窄定位。
// 改任何一个字都等于让既有排障手册失效，因此测试用逐字断言而非子串断言。
//
// 校验分两阶段，与 Go 的 json.Unmarshal + loadStudents 同构：
//
//   阶段一 decodeDocument：类型检查。字段缺失或为 null 按 Go 的零值语义处理
//   （字符串字段得空串、切片字段得空切片，不报错）；字段存在但类型不对（如
//   年级写成字符串、学校写成对象）则整份报「解析 失败」，与 Go 的 cannot
//   unmarshal 同族。
//
//   阶段二 语义校验：按 学校 → 年级 → 班级 → 学生 逐层判定空值与格式，
//   顺序与 Go 完全一致，顺序本身也是语义——同一份文件有多处错误时，最先
//   到达的那处决定文案。
//
// 两阶段不能合并成「边遍历边判类型」：Go 的 unmarshal 先把整份文档的类型错
// 全查完才开始跑 loadStudents，因此一份文件若前面有空校名、后面有类型错误，
// Go 报的是解析失败。就地判类型的实现会先撞上空校名、报出语义文案，与 Go 分叉。
//
// 依赖方向单向：classparse.ts（班级解析与空白剥除）、student.ts（领域形状与
// 构造入口）→ 本文件。本文件不持有第二份年段清单，也不重新实现班级解析或
// 姓名归一化；Grade 的收窄只发生在传给构造入口的那一处。
import { parseClassName, trimGoSpace } from "./classparse";
import type { Grade } from "./grades";
import { newStudentSchool, type RosterStudent } from "./student";

// 源 roster JSON 的形状（上游 build_hierarchy_json.py 的输出）：
//   区县: string
//   学校: [{ 校名: string, 年级: [{ 年级名: string,
//     班级: [{ 班名: string, 学生: [{ 姓名: string }] }] }] }]
//
// 刻意不声明为 TypeScript 接口：本文件从不把 JSON.parse 的结果断言成这个形状，
// 阶段一只按 JSON 路径逐层取值（见 decodeDocument），因此一个「看起来是校验契约」
// 的类型声明在这里是纯负担——它会与真实读取集静默分叉（例如 区县 被声明为 string，
// 而 decodeDocument 根本不读它：该字段在生产逻辑里零消费，Go 的 loadStudents 同样
// 不校验其语义）。形状信息留在注释里，读取动作留在 decodeDocument 里，两者不会彼此
// 冒充。若后续要按 区县 展示，再连同校验与文案一起加——那属于新需求，不是本次平移。
//
// 阶段一的产物：字段已全部落成确定类型，缺失按 Go 零值补齐。
// 语义阶段因此不必再处理「这个字段到底是什么类型」，只判空值与格式。
interface DecodedDocument {
  schools: DecodedSchool[];
}

interface DecodedSchool {
  name: string;
  grades: DecodedGrade[];
}

interface DecodedGrade {
  name: string;
  classes: DecodedClass[];
}

interface DecodedClass {
  name: string;
  students: DecodedStudent[];
}

interface DecodedStudent {
  name: string;
}

// RosterLoadState 跨文件承接的加载态：校名 → 已分配的 SchoolIdx 映射，
// 以及下一个待分配的 SchoolIdx。两项都是 Go 端 loadStudents 里循环外的
// 同一份状态，必须在多次调用之间延续：
//
// - 校名唯一性：跨文件重复校名要报错。若每次调用各自清零，同一所学校在
//   两份文件里出现时会被当成两所学校，下拉里出现重复选项、搜索的学校过滤
//   按 SchoolIdx 分流而同一校名指向两个下标。
// - SchoolIdx 单调递增：schoolList 的输出顺序就是 SchoolIdx 升序，即
//   「文件名的字典序 + 文件内首次出现序」。每次调用从 0 重新分配会让第二份
//   文件里的学校排到第一份之前，下拉顺序与加载序错位。
//
// 契约：**本对象在一次解析失败后不可复用。** 校名占位与 nextSchool 自增发生在
// 各层校验之前（与 Go 同序），因此中途失败会留下「已占位但未产出学生」的残留。
// 拿同一个残留状态重试同一份修好的文件，会报出误导性的「校名重复」——Go 没有
// 这个问题，因为它每次加载都从零建这两张表。调用方（目录遍历 / 管理端）在失败
// 后必须换一份新状态重来（newRosterLoadState），而不是清空后继续用。
//
// 替补做法是「失败时回滚」：在 try 里记录进函数时的快照，catch 里恢复。
// 不做，是因为回滚会掩盖调用顺序的错误——它的代价是让「失败后继续用旧状态」
// 看起来正确，从而无人发现本来就是新旧混用；显式换新态则把契约留在类型与
// 文档上。测试锁住了这条契约的两侧（旧态报重复、新态成功）。
export interface RosterLoadState {
  schoolOrder: Map<string, number>;
  nextSchool: number;
}

// newRosterLoadState 构造一份空加载态：尚未分配任何学校下标。
// 所有加载路径都必须经此入口取得初始状态，而不是手写
// { schoolOrder: new Map(), nextSchool: 0 }。
export function newRosterLoadState(): RosterLoadState {
  return { schoolOrder: new Map(), nextSchool: 0 };
}

// 去重键的分隔符。用 NUL（"\u0000"）而不是任何可见字符：校名/年级名/姓名
// 都是自由文本，可见分隔符可能与某个真实字段值重合，导致「两段拼起来相同但
// 分段不同」的两条记录被误判为同一人。NUL 不会出现在这些字段里（Go 端同一取舍）。
const KEY_SEPARATOR = "\u0000";

// errNoRosterMessage 是「一份名单都没有」的运维指引，与 Go 端 errNoRoster 逐字一致。
// 语义在云端由 rosterStore 承接为「KV 里没有任何 roster」，指引文字不变：
// 它描述的是管理员该做的动作，而不是数据存在的位置。
export function errNoRosterMessage(): string {
  return "数据文件缺失，请将 roster JSON（区县/学校/年级/班级/学生 结构）放入数据目录";
}

// parseRosterDocument 解析一份 roster JSON 原文并校验其结构，把学生追加进
// 通过守门的快照。payload 是文件原文（可能带 BOM）；sourceName 是错误文案里的
// 来源标识（Go 端传文件名，管理端可传校名/上传标识）；state 是跨文件承接的
// 加载态，**必填**：多文件调用点漏传会让「校名唯一 + SchoolIdx 单调」静默失效，
// 必填使漏传变成编译错误。单文件校验（管理端上传一份名单）用 parseSingleDocument。
//
// 失败一律抛错且整份拒绝，绝不部分接受：一份名单里有坏记录时，若只跳过坏记录，
// 服务会带着「看起来正常」的不完整数据对外服务，而运维无从知道少了谁。
// Go 端 fail-closed 的取舍由本函数的抛错承接，调用方转成 503 / 400。
export function parseRosterDocument(payload: string, sourceName: string, state: RosterLoadState): RosterStudent[] {
  // BOM 剥离与 Go 的 bytes.TrimPrefix(payload, {0xEF,0xBB,0xBF}) 同义：
  // 只剥开头的一个，不剥中间的，也不剥第二个。Windows 编辑器保存的 UTF-8
  // 文件常带 BOM，JSON.parse 会把它当成非法字符直接报错——剥掉它，让「用
  // 记事本另存过的名单」与 Go 端一样可加载，而不是报一条误导性的解析失败。
  if (payload.startsWith("\uFEFF")) {
    payload = payload.slice(1);
  }

  const document = decodeDocument(payload, sourceName);

  // 结构守门：合法 JSON 但不是 roster 形状（连 学校 键都没有，或数组为空）。
  // 空对象能过 JSON.parse 而必须死在这里：它解出了一个「没有任何学校」的文档，
  // 若放行会得到一份空名单，服务正常启动并对外返回「没有学生」——把「放错文件」
  // 伪装成「这所学校没有学生」，运维查不出根因。
  if (document.schools.length === 0) {
    throw new Error(`${sourceName} 缺少学校数据（不是 roster 格式）`);
  }

  const students: RosterStudent[] = [];
  // seen 的去重键含学校：跨校同名同班不再互吞。键里的学校段是 trimmed 校名，
  // 与 schoolOrder 的键同源，保证「同一所学校」在两处判定上一致。
  const seen = new Set<string>();

  for (const school of document.schools) {
    // 空白处理逐项走 trimGoSpace（Go 的 strings.TrimSpace 语义）：纯空白的校名
    // 与空串同判为缺失。不能用 String.prototype.trim —— 它会剥掉 U+FEFF，
    // 而 Go 不剥，两端对「这算不算有校名」因此分叉（测试锁住了这个分离点）。
    const schoolName = trimGoSpace(school.name);
    if (schoolName === "") {
      throw new Error(`${sourceName} 存在缺少校名的学校记录`);
    }

    // 校名唯一性：与 Go 的 schoolOrder 重复判定一致，跨文件生效。
    if (state.schoolOrder.has(schoolName)) {
      // 括号是全角「（）」，与 Go 的 "校名重复: %s（%s）" 逐字一致。
      throw new Error(`校名重复: ${schoolName}（${sourceName}）`);
    }
    // SchoolIdx 单调递增：先占位再自增，与 Go 的 schoolIdx := nextSchool;
    // schoolOrder[schoolName] = schoolIdx; nextSchool++ 同序。注意分配发生在
    // 年级/班级/学生的校验之前——后续层级报错时这份文件整份被拒，而本次调用
    // 已分配的 SchoolIdx 会留在加载态里（见 RosterLoadState 的「失败后不可复用」
    // 契约；Go 因整目录重载从零建态，不暴露这一点）。
    const schoolIdx = state.nextSchool;
    state.schoolOrder.set(schoolName, schoolIdx);
    state.nextSchool++;

    for (const grade of school.grades) {
      const gradeName = trimGoSpace(grade.name);
      if (gradeName === "") {
        throw new Error(`${sourceName} / ${schoolName} 存在缺少年级名的年级记录`);
      }
      // 年段值这里做唯一一次类型收窄：未声明年段（如小学「一年级」）在运行时
      // 就是原始字符串，Grade 联合写不出它。收窄放在传参处而不是别处，是为了
      // 让「越过类型边界」只有这一个点——gradeIdx 的越界值由 newStudentSchool
      // 内部的 gradeOrder 自动派生（未匹配到声明年段时返回 gradeValues.length），
      // 本文件不自己算，也不在别处散落断言。schoolList 的「小学不入下拉」
      // 边界依赖的正是这个越界值。
      const gradeValue = gradeName as Grade;

      for (const classItem of grade.classes) {
        const className = trimGoSpace(classItem.name);
        if (className === "") {
          throw new Error(`${sourceName} / ${schoolName} / ${gradeName} 存在缺少班名的班级记录`);
        }
        // 班级格式三态由 parseClassName 归约（非法/溢出/合法），本文件只问
        // 「合法与否」。溢出（全数字但超出安全整数）同样走这条拒绝文案：
        // 数据路径不接受任何非正班号，因为 classNo 为 0 会让「按班级筛选」
        // 永远筛不出人——这是静默行为错误，比整份拒绝更糟。
        const parsed = parseClassName(className);
        if (!parsed.valid) {
          throw new Error(`${sourceName} / ${schoolName} / ${gradeName} 班级格式异常（${className}）`);
        }

        for (const item of classItem.students) {
          // 姓名不 trim：Go 端直接比较 item.Name == ""，空串才拒绝，纯空白姓名
          // 是允许的（真实名单里出现过带前导空格的姓名，Go 端接受并原样保留）。
          // 归一化留给 newStudentSchool 的 nameKey，本文件不改写原始姓名。
          const studentName = item.name;
          if (studentName === "") {
            throw new Error(`${sourceName} / ${schoolName} / ${className} 学生记录格式异常`);
          }

          const student = newStudentSchool(schoolName, studentName, gradeValue, className, parsed.classNo, schoolIdx);
          // 去重键：学校 \x00 年级名 \x00 班号 \x00 姓名匹配键。
          //
          // 用班号而非班名：班名是书写形态，「1班」与「一班」解析出同一个班号，
          // 是同一个班里的同一批人。键若用班名，同一个人会以两条班名不同的记录
          // 进入名单——同一人出现两次，按班级筛选还会把他归到两个「不同」的班。
          //
          // 年级名用 trimmed 原串而非 gradeValue：两者在这里等价（gradeValue 就是
          // 它），但语义上「去重按年级身份」用原串表达更直接，且未声明年段也
          // 不可能因此错判（同一未声明年段名的两次出现本来就该视为同一年级）。
          //
          // 姓名用 nameKey（大写去空白后的归一化形态）：姓名是自由文本，
          // 「张 三」与「张三」是同一个人，数据源里两种写法混用是常态。
          const key = [schoolName, gradeName, String(parsed.classNo), student.nameKey].join(KEY_SEPARATOR);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          students.push(student);
        }
      }
    }
  }
  return students;
}

// parseSingleDocument 是单文件校验的显式入口：管理端上传一份名单、或对一份
// 候选文件做形态校验时用。内部新建一次性加载态，因此不会有跨文件状态，
// 也不会受「失败后 state 不可复用」契约影响。
//
// 单独存在的理由是让两种调用意图在类型上分开：多文件加载必须传 state（漏传
// 是编译错误），单文件校验则不该被要求造一个只活一行的状态对象。
export function parseSingleDocument(payload: string, sourceName: string): RosterStudent[] {
  return parseRosterDocument(payload, sourceName, newRosterLoadState());
}

// decodeDocument 是阶段一：把不可信 JSON 落成确定类型，缺字段按 Go 零值补齐，
// 类型不对则整份报「解析 失败」。错误族与 JSON.parse 失败同一前缀
//（`解析 ${sourceName} 失败: `），细节沿用 Go 的 cannot unmarshal 措辞，
// 使运维在两种失败（语法坏、类型坏）之间可以用同一个 grep 找到，
// 又能从细节区分该改语法还是该改字段类型。
//
// 顶层不是对象时同样报错（Go 的 cannot unmarshal array/number into Go value
// of type sourceDocument）；顶层为 null 按 Go 语义当零值文档处理，落到
// 「缺少学校数据」。数组元素不是对象（如 学校:[123]）与字段类型错误同判。
function decodeDocument(payload: string, sourceName: string): DecodedDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch (error) {
    // 取 message 而不是直接拼对象：否则文案里会出现 "SyntaxError: " 前缀，
    // 与 Go 的文本分叉。
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`解析 ${sourceName} 失败: ${detail}`);
  }

  // 顶层 null 按 Go 的零值文档：不报错，交给「缺少学校数据」判定。
  const document = readRecord(raw === null ? {} : raw, sourceName, "RosterDocument");

  const schools: DecodedSchool[] = [];
  // 每层都显式算一条 JSON 路径（schoolPath / gradePath / classPath），
  // 类型错误的文案里带它，运维因此能直接定位到「第几个学校第几个年级第几个班」，
  // 而不必猜 Go 的 struct field 名。路径只用于错误文案，不参与任何判定。
  for (const [index, rawSchool] of readArray(document.学校, sourceName, "RosterDocument.学校").entries()) {
    const schoolPath = `RosterDocument.学校[${index}]`;
    const school = readRecord(rawSchool, sourceName, schoolPath);
    const grades: DecodedGrade[] = [];
    for (const [gradeIndex, rawGrade] of readArray(school.年级, sourceName, `${schoolPath}.年级`).entries()) {
      const gradePath = `${schoolPath}.年级[${gradeIndex}]`;
      const grade = readRecord(rawGrade, sourceName, gradePath);
      const classes: DecodedClass[] = [];
      const classPath = `${gradePath}.班级`;
      for (const [classIndex, rawClass] of readArray(grade.班级, sourceName, classPath).entries()) {
        const currentClassPath = `${classPath}[${classIndex}]`;
        const classItem = readRecord(rawClass, sourceName, currentClassPath);
        const students: DecodedStudent[] = [];
        const studentPath = `${currentClassPath}.学生`;
        for (const [studentIndex, rawStudent] of readArray(classItem.学生, sourceName, studentPath).entries()) {
          const currentStudentPath = `${studentPath}[${studentIndex}]`;
          const student = readRecord(rawStudent, sourceName, currentStudentPath);
          students.push({ name: readText(student.姓名, sourceName, `${currentStudentPath}.姓名`) });
        }
        classes.push({ name: readText(classItem.班名, sourceName, `${currentClassPath}.班名`), students });
      }
      grades.push({ name: readText(grade.年级名, sourceName, `${gradePath}.年级名`), classes });
    }
    schools.push({ name: readText(school.校名, sourceName, `${schoolPath}.校名`), grades });
  }
  return { schools };
}

// readText 读取字符串字段的三态语义：缺失或 null 得空串（Go 零值，不报错）；
// 是字符串则原样返回；其余类型（数字、布尔、对象、数组）整份报解析失败。
//
// 与旧实现的关键差别：旧版把「类型不对」也换成空串，于是 {"年级":"高一"}
// 这类输入被静默当成「没有年级」，产出空名单、服务正常启动对外报「没有学生」
// ——正是「放错文件伪装成这所学校没有学生」的同一种病。Go 端对同一输入是
// 解析失败，运维能立刻看出文件结构坏了。
function readText(value: unknown, sourceName: string, path: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return throwTypeMismatch(value, sourceName, path, "string");
}

// readArray 读取数组字段的三态语义：缺失或 null 得空数组（Go 的 nil 切片，
// 不报错）；是数组则原样返回；其余类型整份报解析失败。
function readArray(value: unknown, sourceName: string, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return throwTypeMismatch(value, sourceName, path, "array");
}

// readRecord 读取对象元素的三态语义：缺失或 null 得空对象（Go 的零值结构体，
// 于是 学校:[null] 会落到「缺少校名」，与 Go 一致）；是对象则原样返回；
// 其余类型（数字、字符串、数组）整份报解析失败。
function readRecord(value: unknown, sourceName: string, path: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return throwTypeMismatch(value, sourceName, path, "object");
}

// throwTypeMismatch 构造并抛出类型不匹配错误，返回 never 使调用点可以直接
// 当「此路不通」的分支返回。措辞沿用 Go 的 cannot unmarshal 形态，并补上
// 字段路径（Go 的 struct field 名对运维不够直观，JSON 路径才指向具体位置）。
function throwTypeMismatch(value: unknown, sourceName: string, path: string, expected: string): never {
  throw new Error(
    `解析 ${sourceName} 失败: json: cannot unmarshal ${jsonKindOf(value)} into Go value of type ${expected}（字段 ${path}）`,
  );
}

// jsonKindOf 把运行时值映射为 Go cannot unmarshal 文案里的类型名。
// 只覆盖 JSON 能产出的六种形态：object / array / string / number / bool / null。
function jsonKindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "bool";
    default:
      return "unknown";
  }
}
