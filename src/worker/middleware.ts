// 横切关注点：安全响应头与访问日志，平移自 Go 端 server/middleware.go 与 server/ip.go。
//
// 与 Go 的形态差异只有装配位置，不涉及行为：
// Go 的 accessLog(securityHeaders) 是包装 http.Handler 的中间件，靠 statusRecorder
// 截获状态码、靠 time.Since 计时；Workers 侧的 Response 自带 status、耗时由装配层
// 从时钟读，所以本层的 accessLog 收 (request, status, elapsedMs) 直接写日志。
// 客户端 IP 的来源也因此不同：Go 用 r.RemoteAddr（含端口），Workers 用边缘注入的
// cf-connecting-ip 头（裸地址）。maskedIP 对两种形态都能处理，脱敏规则不分叉。
//
// 链顺序（securityHeaders / rateLimit / accessLog 谁在外）不由本文件决定，
// 与 Go 一样收敛在装配层一处（迁移评审要求）。

// 安全响应头的值逐字对齐 server/middleware.go 的 setSecurityHeaders。
// 值里的空格顺序也是契约的一部分：前端资源与浏览器解析都按这份字符串，
// 改写顺序或拆行会让「逐字对齐 Go」这句丧失可核对性。
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  [
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; font-src 'self'; style-src 'self' 'unsafe-inline'"
  ],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "geolocation=(), microphone=(), camera=()"],
  ["X-Content-Type-Options", "nosniff"],
  ["Cache-Control", "no-store"]
];

// setSecurityHeaders 是全站安全响应头的唯一事实源。
// 正常路径与限流拒绝路径都必须经过它，避免 429 成为头部例外（与 Go 同义）。
// 用 set 而非 append：调用点若已设同名头（例如缓存策略），此处必须覆盖，
// 否则宽松的旧值会与这里的策略一起漏出去，出现两个值拼接的头。
export function setSecurityHeaders(headers: Headers): void {
  for (const [name, value] of SECURITY_HEADERS) {
    headers.set(name, value);
  }
}

// IPv4 字面量：四段十进制、每段 0-255、不得有前导零。
// 前导零必须拒绝：Go 的 net.ParseIP 拒绝（"010.1.1.01" 解析失败），
// 若此处接受并归一，同一地址在两侧就会得到「脱敏」与「unknown」两种日志形态。
const IPv4_LITERAL = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;

// IPv4-mapped 地址经 WHATWG 归一后的文本形态：::ffff:XXXX:YYYY。
// 后两组就是 IPv4 地址的两个高位段与低位段，取出来后换算成点分即得纯 IPv4。
const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

// parseIPv4 把点分文本归一为无前导零的点分形态；非法输入返回 null。
function parseIPv4(text: string): string | null {
  if (!IPv4_LITERAL.test(text)) {
    return null;
  }
  const parts = text.split(".");
  for (const part of parts) {
    if (Number(part) > 255) {
      return null;
    }
  }
  return parts.join(".");
}

// canonicalIPv6 用 WHATWG URL 做 IPv6 的语法校验与归一（压缩零组、小写十六进制），
// 输出与 Go 的 net.IP.String() 同形。选它而不是手写 IPv6 解析器：
// 压缩零组、省略尾随零、前导零清除这些细节在平台里已经实现，手写只是把
// RFC 4291 抄一遍并引入自己的边界错误。
// 非法文本（组数超限、非十六进制、空串）一律返回 null，由调用方降级 unknown。
function canonicalIPv6(text: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(`http://[${text}]/`).hostname;
  } catch {
    return null;
  }
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
    return null;
  }
  return hostname.slice(1, -1);
}

// parseIP 归一化为两种形态之一：IPv4 的点分文本或 IPv6 的规范文本。
// IPv4-mapped（::ffff:a.b.c.d）在此直接折算成点分形态，与 Go 的
// net.ParseIP 后 ip.String() 行为一致——Go 的 String 对 To4 成功的地址
// 输出点分，不保留 ::ffff: 前缀。
function parseIP(text: string): { family: "v4" | "v6"; text: string } | null {
  const v4 = parseIPv4(text);
  if (v4 !== null) {
    return { family: "v4", text: v4 };
  }
  const v6 = canonicalIPv6(text);
  if (v6 === null) {
    return null;
  }
  const mapped = IPV4_MAPPED.exec(v6);
  if (mapped !== null) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return {
      family: "v4",
      text: `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
    };
  }
  return { family: "v6", text: v6 };
}

// clientIP 从请求方给的地址串里提取裸 IP，是客户端 IP 解析的唯一入口。
// 规则逐条对齐 Go 的 ip.go clientIP：
//   - 方括号 IPv6（可带端口）：取方括号内的部分
//   - 单冒号的 host:port（IPv4 形态）：丢掉最后一次冒号之后的内容
//     （判定条件与 Go 一致：只有在非方括号且冒号恰好一个时才去端口，
//     IPv6 裸地址本身就带多个冒号，不能被误去尾）
//   - 去掉 IPv6 zone（%eth0 / %251）
//   - 能归一就归一，不能就原样返回，交给 maskedIP 决定是否降级
function clientIP(address: string): string {
  let host = address;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end >= 0) {
      host = host.slice(1, end);
    }
  } else {
    const colon = host.lastIndexOf(":");
    if (colon >= 0 && host.split(":").length === 2) {
      host = host.slice(0, colon);
    }
  }
  const zone = host.indexOf("%");
  if (zone >= 0) {
    host = host.slice(0, zone);
  }
  return parseIP(host)?.text ?? host;
}

// maskedIP 脱敏客户端 IP 用于访问日志（隐私红线：只保留前缀，不记录完整地址）。
// 规则逐条对齐 Go 的 ip.go maskedIP：
//   - IPv4 保留前两段，输出 a.b.*.*
//   - IPv6 保留前两组，输出 a:b:::*；首位组为空（::1、:: 这类回环/任意地址）
//     保守降级 unknown，与 Go 一致
//   - 归一失败的畸形输入一律 unknown，绝不把疑似端口/字段前缀漏进日志
// 输出形态刻意照搬 Go 的实际结果而不做美化：fe80::1 在 Go 里就是 fe80::::*，
// 这里照旧，避免「日志格式双方不同形」这种需要靠人脑对照的差异。
export function maskedIP(address: string): string {
  const ip = parseIP(clientIP(address));
  if (ip === null) {
    return "unknown";
  }
  if (ip.family === "v4") {
    const [first, second] = ip.text.split(".");
    return `${first}.${second}.*.*`;
  }
  const groups = ip.text.split(":");
  if (groups.length >= 2 && groups[0] !== "") {
    return `${groups[0]}:${groups[1]}:::*`;
  }
  return "unknown";
}

// formatDuration 把毫秒数格式化成 Go 的 time.Duration.String() 形态。
// Go 侧的口径是 d.Round(time.Millisecond).String()：0 与亚毫秒都写成 0s，
// 1-999 写 Nms，整秒以上写带小数的秒（1.234s 这种，尾随零由数字形态自然消掉）。
// ponytail: 满 60s 时 Go 会写 1m0s，这里仍是 60s。单请求超过一分钟属于
// 应当被单独排查的异常，日志里 60s 与 1m0s 指向同一事实，等真有这类记录
// 需要机器对拍时再补分钟分支。
function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded <= 0) {
    return "0s";
  }
  if (rounded < 1000) {
    return `${rounded}ms`;
  }
  return `${rounded / 1000}s`;
}

// accessLog 记录一条访问日志：方法、路径、状态、耗时、脱敏客户端 IP。
// 隐私红线：不记录查询参数与响应内容，IP 只留前缀（与 Go 的注释同义）。
// healthcheck 探针每 30s 一次，不产生访问日志（否则就是每天近三千行噪音），
// 守卫留在本函数内，与 Go 一样由横切层自己负责，不指望装配层记得。
//
// 路径取 URL 的 pathname 而非 request.url 原串：后者含查询串，正是红线要挡的东西。
// 与 Go 的 r.URL.Path 有一处细微差异：Go 的 Path 是百分号解码后的形态，
// 这里保留原始编码。日志用途下两者等价（都是人读的路径），且保留编码可以
// 避开 decodeURIComponent 对畸形转义抛错的问题。
export function accessLog(request: Request, status: number, elapsedMs: number): void {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") {
    return;
  }
  const ip = maskedIP(request.headers.get("cf-connecting-ip") ?? "");
  console.log(`access ${request.method} ${path} ${status} ${formatDuration(elapsedMs)} ${ip}`);
}
