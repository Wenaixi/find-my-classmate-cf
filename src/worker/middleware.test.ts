// 横切关注点的回归测试，平移自 Go 端 server/security_test.go、server/ip_test.go、
// server/accesslog_test.go 与 server/healthlog_test.go。
//
// 期望值不是从被测实现里抄回来的：maskedIP 的每条用例都取自 Go 端 maskedIP 的
// 实际输出（用真实 server/ip.go 跑出的输入输出对照表），因此这些断言真正承重
// 「语义平移」——实现分叉时它们会翻红，而不是把分叉一起合法化。
//
// 与 Go 的形态差异只在装配处，不在被断言的行为处：
// Go 的 accessLog 是包装 http.Handler 的中间件，由 statusRecorder 记录状态、
// 由 time.Since 计算耗时；worker 侧这三个值由调用方给出（Workers 的 Response
// 自带 status，耗时由装配层读 clock），本层只负责格式与隐私红线。
import { describe, expect, it, vi } from "vitest";
import { accessLog, maskedIP, setSecurityHeaders } from "./middleware";

// 六个安全头的名与值逐字对齐 server/middleware.go 的 setSecurityHeaders。
// 用逐字相等而不是「非空」断言：Go 测试只查存在性与 CSP 片段，那挡不住
// 值被改写成更宽松的策略（例如 Permissions-Policy 丢掉 camera 禁用）。
const SECURITY_HEADER_NAMES = [
  "Content-Security-Policy",
  "X-Frame-Options",
  "Referrer-Policy",
  "Permissions-Policy",
  "X-Content-Type-Options",
  "Cache-Control"
] as const;

const EXPECTED_SECURITY_HEADERS: Record<(typeof SECURITY_HEADER_NAMES)[number], string> = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; font-src 'self'; style-src 'self' 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store"
};

// captureLogs 把 console.log 的每次调用收成一行，越过实现细节直接断言日志出口。
// 只替换 console.log 而不是整个 console：实现若改用 console.info 或 console.warn，
// 这里的收集器会落空，用例随之翻红——「日志通道是 console.log」本身被钉住。
function captureLogs(run: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

// makeRequest 构造带客户端 IP 的请求。cf-connecting-ip 是 Workers 里客户端 IP
// 的来源（Go 对应 r.RemoteAddr），此处刻意用裸 IP 形态，与边缘注入的值一致。
function makeRequest(path: string, clientIP?: string): Request {
  const headers = new Headers();
  if (clientIP !== undefined) {
    headers.set("cf-connecting-ip", clientIP);
  }
  return new Request(`https://fmc.example${path}`, { headers });
}

describe("setSecurityHeaders", () => {
  it("六个头的值逐字等于 Go 端 setSecurityHeaders", () => {
    const headers = new Headers();
    setSecurityHeaders(headers);

    for (const name of SECURITY_HEADER_NAMES) {
      // Headers 的值会做空白折叠，这里顺手把两边都归一后比较：
      // 真正的逐字契约是「词与顺序一致」，多余空白不属于契约。
      expect(headers.get(name)).toBe(EXPECTED_SECURITY_HEADERS[name]);
    }
  });

  it("只设置这六个头，不夹带别的", () => {
    const headers = new Headers();
    setSecurityHeaders(headers);

    // 头名规范化后排序比较：新增第七个头会让本条翻红。
    // 这条不是形式主义：多出来的头（例如 Access-Control-Allow-Origin）会
    // 直接改变浏览器侧的安全姿态，而 Go 只有这六个。
    const names = [...headers.keys()].sort();
    expect(names).toEqual([...SECURITY_HEADER_NAMES].map((name) => name.toLowerCase()).sort());
  });

  it("覆盖调用点已有的同名头，与 Go 的 Header.Set 同义", () => {
    const headers = new Headers({
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "public, max-age=3600"
    });
    setSecurityHeaders(headers);

    // 限流拒绝路径与正常路径都经过同一个 setSecurityHeaders，若这里退化成
    // 「只在缺失时设置」的 append 语义，调用点先前设的宽松值就会漏出去。
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("maskedIP", () => {
  // 每条期望值都来自真实 server/ip.go 的输出对照表，不是推测。
  const cases: Array<{ input: string; want: string; note: string }> = [
    { input: "1.2.3.4:5678", want: "1.2.*.*", note: "IPv4 带端口，去端口后保留前两段" },
    { input: "1.2.3.4", want: "1.2.*.*", note: "IPv4 裸地址" },
    { input: "192.168.1.1", want: "192.168.*.*", note: "私网地址同样只留前两段" },
    { input: "0.0.0.0", want: "0.0.*.*", note: "全零地址是合法 IPv4，不降级" },
    { input: "255.255.255.255", want: "255.255.*.*", note: "上界地址" },
    { input: "[1.2.3.4]:80", want: "1.2.*.*", note: "方括号包 IPv4 加端口" },
    { input: "1.2.3.4:abc", want: "1.2.*.*", note: "端口段非数字仍按 IPv4 host 处理" },
    { input: "[2001:db8::1]:8080", want: "2001:db8:::*", note: "IPv6 带端口，保留前两组" },
    { input: "[2001:db8::1]", want: "2001:db8:::*", note: "IPv6 方括号无端口" },
    { input: "2001:db8::1", want: "2001:db8:::*", note: "IPv6 裸地址" },
    { input: "2001:db8::1%eth0", want: "2001:db8:::*", note: "去 IPv6 zone 后缀" },
    {
      input: "[2001:db8:85a3:0:0:8a2e:370:7334]:443",
      want: "2001:db8:::*",
      note: "长 IPv6 归一后取前两组，后续分组不落日志"
    },
    {
      input: "2001:0db8:0000::1",
      want: "2001:db8:::*",
      note: "归一化去前导零与多余零组后取前两组"
    },
    { input: "1:2:3:4:5:6:7:8", want: "1:2:::*", note: "无零可压缩的完整八组" },
    { input: "::ffff:192.168.1.1", want: "192.168.*.*", note: "IPv4-mapped 归一为纯 IPv4" },
    { input: "[::ffff:192.168.1.1]:8080", want: "192.168.*.*", note: "方括号 IPv4-mapped 带端口" },
    {
      input: "::ffff:c0a8:101",
      want: "192.168.*.*",
      note: "十六进制写法的 IPv4-mapped 同样归一为纯 IPv4"
    },
    { input: "::1", want: "unknown", note: "IPv6 回环首位组为空，与 Go 一样降级" },
    { input: "[::1]:443", want: "unknown", note: "方括号回环带端口" },
    { input: "::", want: "unknown", note: "IPv6 任意地址降级，不输出 ::****** 这类无意义串" },
    {
      input: "fe80::1",
      want: "fe80::::*",
      note: "链路本地地址：第二组为空，Go 实际输出就是 fe80::::*，此处照搬不美化"
    },
    { input: "1.2.3.4:5678:999", want: "unknown", note: "多冒号畸形串，ParseIP 失败" },
    { input: "999.888.777.666", want: "unknown", note: "越界 IPv4 字段" },
    { input: "010.1.1.01", want: "unknown", note: "前导零 IPv4：Go 拒绝，此处必须同样拒绝" },
    { input: "1.2.3.04", want: "unknown", note: "末段前导零" },
    { input: "1.2.3", want: "unknown", note: "少于四段" },
    { input: "1.2.3.4.5", want: "unknown", note: "多于四段" },
    { input: " 1.2.3.4", want: "unknown", note: "前后空白：Go 不裁剪，脱敏不得比它宽松" },
    { input: "1.2.3.4 ", want: "unknown", note: "尾随空白同样不裁剪" },
    { input: "1:2:3:4:5:6:7:8:9", want: "unknown", note: "九组 IPv6，ParseIP 失败" },
    { input: "::1:2:3:4:5:6:7", want: "0:1:::*", note: "压缩后首位组补零为 0，保留 0 与 1" },
    { input: "unknown", want: "unknown", note: "上游已给占位串时不二次加工" },
    { input: "", want: "unknown", note: "空输入" }
  ];

  for (const { input, want, note } of cases) {
    it(`${JSON.stringify(input)} -> ${want}（${note}）`, () => {
      expect(maskedIP(input)).toBe(want);
    });
  }

  it("任何输入都不把完整地址原样带出去", () => {
    // 隐私红线的兜底断言：对一批真实形态的输入，输出必须与输入不同且
    // 不包含输入的后半部分。函数级断言之外再钉一次性质，防止新增分支时
    // 出现「规范化后原样返回」的意外。
    const inputs = ["203.0.113.45", "2001:db8:85a3::8a2e:370:7334", "[2001:db8::99]:8443"];
    for (const input of inputs) {
      const masked = maskedIP(input);
      expect(masked).not.toBe(input);
      expect(input.includes(masked) && masked.includes(".") && !masked.includes("*")).toBe(false);
    }
  });
});

describe("accessLog", () => {
  it("输出 access 方法 路径 状态 耗时 脱敏 IP", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/search?q=王", "203.0.113.45"), 200, 12);
    });

    expect(lines).toHaveLength(1);
    // 逐字断言整行：格式一旦漂移（多项、少项、换分隔符），下游的日志
    // 检索与告警规则就全部失效，而它不会以任何测试失败之外的形式报警。
    expect(lines[0]).toBe("access GET /api/search 200 12ms 203.0.*.*");
  });

  it("不记录查询参数", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/search?q=王小红&limit=50", "198.51.100.7"), 200, 3);
    });

    expect(lines[0]).toContain("/api/search");
    // 正向与反向同时断言：只查「不含 q=」时，实现若改成记录空路径也会通过。
    for (const leaked of ["q=", "王小红", "limit=50"]) {
      expect(lines[0]).not.toContain(leaked);
    }
  });

  it("记录完整 IP 的后两段即视为泄露", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/schools", "203.0.113.45"), 200, 5);
    });

    expect(lines[0]).toContain("203.0.*.*");
    expect(lines[0]).not.toContain("113.45");
  });

  it("IPv6 客户端保留前两组并遮蔽其余", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/search", "2001:db8:85a3:0:0:8a2e:370:7334"), 200, 8);
    });

    expect(lines[0]).toContain("2001:db8:::*");
    for (const leaked of ["8a2e", "7334", "85a3"]) {
      expect(lines[0]).not.toContain(leaked);
    }
  });

  it("缺客户端 IP 头时输出 unknown 而不是空字段", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/search"), 200, 1);
    });

    // 少一项会让日志行错位，用占位串保住列数。
    expect(lines[0]).toBe("access GET /api/search 200 1ms unknown");
  });

  it("零耗时的写法对齐 Go 的 Duration 字符串", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/search", "203.0.113.45"), 204, 0);
    });

    // Go 对 0 耗时（Round 到毫秒后归零）写出的是 "0s" 而不是 "0ms"。
    expect(lines[0]).toBe("access GET /api/search 204 0s 203.0.*.*");
  });

  it("health 探针不记录，守卫在本函数内", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/health", "203.0.113.45"), 200, 1);
    });

    // healthcheck 每 30s 一次，记下来就是每天近三千行噪音。
    expect(lines).toHaveLength(0);
  });

  it("health 之外的路径照常记录", () => {
    // 与上一条成对：只断言「health 不记」时，实现若整体不记也会通过。
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/healthz", "203.0.113.45"), 200, 1);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/api/healthz");
  });

  it("错误状态码照样入日志", () => {
    const lines = captureLogs(() => {
      accessLog(makeRequest("/api/nope", "203.0.113.45"), 404, 2);
    });

    expect(lines[0]).toBe("access GET /api/nope 404 2ms 203.0.*.*");
  });

  it("方法按请求原样记录", () => {
    const lines = captureLogs(() => {
      accessLog(new Request("https://fmc.example/api/search", { method: "POST" }), 405, 1);
    });

    // 405 是 method_not_allowed 的主要来源，方法字段是它的唯一线索。
    expect(lines[0]).toBe("access POST /api/search 405 1ms unknown");
  });
});
