// 年段值域（Grade 联合、gradeValues、gradeAliases）的单一 owner，前端各消费方
// 一律从本文件取值：types.ts 只 re-export Grade，shared/query.ts 在本文件取
// gradeValues / gradeAliases。
//
// 年段值域与迁移前 Go 端 search.go 的 knownGrades 曾是同一份事实，Go 退役后
// 本文件是唯一声明处。扩展年段时只改本文件：追加 Grade 联合与 gradeValues，
// 下方的反向完整性检查会在漏改一侧时立即报错。
//
// 声明为字面量元组而非 ReadonlyArray<Grade>：显式类型标注会把字面量拓宽回
// Grade，于是「Grade 联合里有、gradeValues 里缺」在类型层面恒成立，下方的
// 反向完整性检查形同虚设。as const 保留字面量类型，satisfies 保住另一个方向：
// 写出的值必须属于 Grade。两者缺一不可——只写 as const 会丢掉正向强制，
// 只写 satisfies 则类型仍被拓宽。
export type Grade = "高一" | "高二" | "高三";

export const gradeValues = ["高一", "高二", "高三"] as const satisfies readonly Grade[];

// 别名 → 规范名：用户可写「高1」，而 grade 字段与后端仍用规范名。
// 别名的规范名目标同样受 satisfies 约束，指向未声明年段时点名报错。
export const gradeAliases = [
  ["高1", "高一"],
  ["高2", "高二"],
  ["高3", "高三"],
] as const satisfies readonly (readonly [string, Grade])[];

// 声明的年段全貌，供测试锁住「规范名与别名一一对应且都属于合法 Grade」。
export const gradeDomain: { values: typeof gradeValues; aliases: typeof gradeAliases } = {
  values: gradeValues,
  aliases: gradeAliases,
};

// 年段值域的反向完整性：Grade 联合里出现 gradeValues 未声明的年段时报错。
// 正向（列表里的值必须属于 Grade）由上面的 satisfies 强制，本处强制反向
// （Grade 里的值必须已在列表中声明），两个方向各由一处承担。
// 此前这条反向由 query.test.ts 里手抄的枚举数组承担，而手抄副本在 Grade
// 联合追加新成员时不会跟着长：实测加「高四」后 tsc 干净、全部用例通过，
// 而 parseQuery 已不再识别该年段。断言存在却不承重它声称的对象，比没有
// 断言更危险——它提供虚假的覆盖感。
// 报错形态刻意带出缺失项本身（缺「高四」时该类型退化为 { missing: "高四" }），
// 而不是让 Exclude 直接得 never 后报一条无从解读的 never 不兼容。
//
// 检查必须落在非测试文件：.dockerignore 排除 src/**/*.test.ts，
// 放进测试文件则容器镜像构建的 tsc -b 不再检查它，会造出一条「本地绿、
// 镜像不查」的隐形防线。gradeDomainExhaustive 在生产代码中无人消费，
// tsc 不报错（tsconfig.app.json 未开 noUnusedLocals，全仓无 eslint 配置与
// lint 脚本）。
type GradeDomainGap = Exclude<Grade, (typeof gradeValues)[number]>;
const gradeDomainExhaustive: GradeDomainGap extends never ? true : { missing: GradeDomainGap } = true;
void gradeDomainExhaustive;