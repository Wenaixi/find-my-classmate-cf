// 前端消费入口：跨端契约常量 re-export 自 shared/contract.ts（唯一事实源），
// 本文件不再声明这些数值，只保留前端私有的 REQUEST_TIMEOUT_MS。

export { PAGE_SIZE, MAX_LIMIT, MAX_QUERY_LENGTH } from "./shared/contract";

/** 网络请求超时（毫秒，前端私有，不进 shared） */
export const REQUEST_TIMEOUT_MS = 10_000;
