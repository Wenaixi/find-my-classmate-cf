// 名单加载守门的单一 owner：把 Go 端 server/data.go 的 loadStudents 对
// **单份 roster 文件**的校验语义平移为纯函数。目录遍历（文件名排序、后缀筛选、
// 空目录守卫、热重载与失败冷却）不在本文件职责内，由后续 rosterStore 承接；
// 本文件只管「一份 JSON 原文 → 学生快照」，或整份拒绝。
//
// 错误文案与 Go 逐字一致，这是本文件的硬约束：运维靠这句话判断该去看哪一份
// 文件的哪一层。文案里带 来源名（文件名）/ 校名 / 年级名 / 班名，逐层收窄定位。
// 改任何一个字都等于让既有排障手册失效，因此测试用逐字断言而非子串断言。
//
// 校验顺序与 Go 完全一致，顺序本身也是语义：先判整体结构（有没有学校数组），
// 再按 学校 → 年级 → 班级 → 学生 的层级逐条向下。同一份文件有多处错误时，
// 最先到达的那处决定文案——顺序变了，运维看到的错误就变了。
//
// 依赖方向单向：grades.ts（年段值域）、classparse.ts（班级解析与空白剥除）、
// student.ts（领域形状与构造入口）→ 本文件。本文件不持有第二份年段清单，
// 也不重新实现班级解析或姓名归一化。
import { parseClassName, trimGoSpace } from "./classparse";
import type { Grade } from "./grades";
import { newStudentSchool, type RosterStudent } from "./student";

// 源 JSON 的文档形状，字段名保持中文键：这是上游 build_hierarchy_json.py
// 输出的真实形状，与领域形状 RosterStudent 是两个不同的类型——前者是磁盘/传输
// 上的原文，后者是加载后的领域对象。所有字段都可能缺失或类型不符（JSON 是
// 不可信输入），因此类型上不承诺「已存在」，由本文件的运行时守门逐层检查。
export interface RosterDocument {
  区县?: string;
  学校?: Array<{
    校名?: string;
    年级?: Array<{
      年级名?: string;
      班级?: Array<{
        班名?: string;
        学生?: Array<{ 姓名?: string }>;
      }>;
    }>;
  }>;
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
// 用可变对象而非「返回值带上新状态」：调用方是目录遍历循环，它本来就持有
// 这份状态并逐份递进；Go 端也是同一个循环里的两个局部变量。返回新状态会
// 迫使调用方每次解构重赋，而漏更新一次就是静默的顺序错乱。
export interface RosterLoadState {
  schoolOrder: Map<string, number>;
  nextSchool: number;
}

// newRosterLoadState 构造一份空加载态：尚未分配任何学校下标。
// 所有加载路径都必须经此入口取得初始状态，而不是手写 { schoolOrder: new Map(), nextSchool: 0 }。
export function newRosterLoadState(): RosterLoadState {
  return { schoolOrder: new Map(), nextSchool: 0 };
}

// 去重键的分隔符。用 NUL（"\x00"）而不是任何可见字符：校名/年级名/姓名都是
// 自由文本，可见分隔符可能与某个真实字段值重合，导致「两段拼起来相同但分段
// 不同」的两条记录被误判为同一人。NUL 不会出现在这些字段里（Go 端同一取舍）。
const KEY_SEPARATOR = "\u0000";

// errNoRosterMessage 是「一份名单都没有」的运维指引，与 Go 端 errNoRoster 逐字一致。
// 语义在云端由 rosterStore 承接为「KV 里没有任何 roster」，指引文字不变：
// 它描述的是管理员该做的动作，而不是数据存在的位置。
export function errNoRosterMessage(): string {
  return "数据文件缺失，请将 roster JSON（区县/学校/年级/班级/学生 结构）放入数据目录";
}

// parseRosterDocument 解析一份 roster JSON 原文并校验其结构，返回通过守门的学生快照。
// payload 是文件原文（可能带 BOM，可能不是 UTF-8 意义上的合法 JSON）；
// sourceName 是错误文案里的来源标识（Go 端传文件名，管理端可传校名/上传标识）。
// state 是跨文件承接的加载态；缺省时用一份新状态，供单文件校验（如管理端
// 上传单个校区的名单）使用。
//
// 失败一律抛错且整份拒绝，绝不部分接受：一份名单里有坏记录时，若只跳过坏记录，
// 服务会带着「看起来正常」的不完整数据对外服务，而运维无从知道少了谁。
// Go 端 fail-closed 的取舍由本函数的抛错承接，调用方转成 503 / 400。
export function parseRosterDocument(payload: string, sourceName: string, state: RosterLoadState = newRosterLoadState()): RosterStudent[] {
  // BOM 剥离与 Go 的 bytes.TrimPrefix(payload, {0xEF,0xBB,0xBF}) 同义：
  // 只剥开头的一个，不剥中间的，也不剥第二个。Windows 编辑器保存的 UTF-8
  // 文件常带 BOM，JSON.parse 会把它当成非法字符直接报错——剥掉它，让「用
  // 记事本另存过的名单」与 Go 端一样可加载，而不是报一条误导性的解析失败。
  if (payload.startsWith("\uFEFF")) {
    payload = payload.slice(1);
  }

  let document: RosterDocument;
  try {
    document = JSON.parse(payload) as RosterDocument;
  } catch (error) {
    // 与 Go 的 fmt.Errorf("解析 %s 失败: %w", name, err) 同形：前缀逐字一致，
    // 底层解析器细节随后。JSON.parse 抛的是 SyntaxError，取 message 而不是
    // 直接拼对象——否则文案里会出现 "SyntaxError: " 前缀，与 Go 的文本分叉。
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`解析 ${sourceName} 失败: ${detail}`);
  }

  // 结构守门：合法 JSON 但不是 roster 形状（连 学校 键都没有，或数组为空）。
  // 空对象能过 JSON.parse 而必须死在这里：它解出了一个「没有任何学校」的文档，
  // 若放行会得到一份空名单，服务正常启动并对外返回「没有学生」——把「放错文件」
  // 伪装成「这所学校没有学生」，运维查不出根因。
  //
  // 判定用 Array.isArray 而非只判长度：JSON 里 学校 也可能是字符串或对象，
  // 那些形状没有 length（或 length 语义完全不同），直接取长度会得到 undefined
  // 或荒谬的值，让守门的判据本身失效。
  const schools = Array.isArray(document?.学校) ? document.学校 : [];
  if (schools.length === 0) {
    throw new Error(`${sourceName} 缺少学校数据（不是 roster 格式）`);
  }

  const students: RosterStudent[] = [];
  // seen 的去重键含学校：跨校同名同班不再互吞。键里的学校段是 trimmed 校名，
    // 与 schoolOrder 的键同源，保证「同一所学校」在两处判定上一致。
  const seen = new Set<string>();

  for (const school of schools) {
    // 空白处理逐项走 trimGoSpace（Go 的 strings.TrimSpace 语义）：纯空白的校名
    // 与空串同判为缺失。不能用 String.prototype.trim —— 它会剥掉 U+FEFF，
    // 而 Go 不剥，两端对「这算不算有校名」因此分叉。
    const schoolName = trimGoSpace(textOf(school?.校名));
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
    // 年级/班级/学生的校验之前——后续层级报错时这份文件整份被拒，但本次调用
    // 已经分配的 SchoolIdx 会留在加载态里。这与 Go 端行为一致：Go 的
    // loadStudents 出错时整个目录加载失败，内存快照不被发布，下一次重载
    // 重新从空状态开始分配，因此残留的占位不会进入任何对外快照。
    const schoolIdx = state.nextSchool;
    state.schoolOrder.set(schoolName, schoolIdx);
    state.nextSchool++;

    for (const grade of arrayOf(school?.年级)) {
      const gradeName = trimGoSpace(textOf(grade?.年级名));
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

      for (const classItem of arrayOf(grade?.班级)) {
        const className = trimGoSpace(textOf(classItem?.班名));
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

        for (const item of arrayOf(classItem?.学生)) {
          // 姓名不 trim：Go 端直接比较 item.Name == ""，空串才拒绝，纯空白姓名
          // 是允许的（真实名单里出现过带前导空格的姓名，Go 端接受并原样保留）。
          // 归一化留给 newStudentSchool 的 nameKey，本文件不改写原始姓名。
          const studentName = textOf(item?.姓名);
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

// textOf 把 JSON 里不保证是字符串的字段安全转成字符串。
// 只接受字符串原样返回，其余（数字、布尔、null、对象、数组）一律转成空串：
// 空串会落到上层「缺失」判定并报出对应的层级文案，而不是抛一条 TypeError。
//
// 这条取舍的理由是错误定位：真实名单是脚本生成的，字段类型写错（如姓名写成
// 数字）时，运维需要看到「学生记录格式异常」并知道是哪份文件哪个班，而不是
// 一条与数据无关的 JS 运行时异常。非字符串字段在这里一律按缺失处理。
function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// arrayOf 把 JSON 里不保证是数组的字段安全转成数组：不是数组就当空数组。
// 缺 年级 的学校、缺 班级 的年级都在形状上「没有下级」，与空数组同义，
// 都产出零名学生而不是报错——Go 端的 json.Unmarshal 对缺失数组字段同样得到
// 长度为 0 的切片，本函数与它逐条对齐。
function arrayOf<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
