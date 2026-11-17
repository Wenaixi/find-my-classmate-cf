// 跨端契约常量（PAGE_SIZE / MAX_LIMIT / MAX_QUERY_LENGTH）的单一 owner，
// 前端与 Worker 一律从本文件取值：src/config.ts 直接 re-export 本文件，
// App.tsx、lib/searchReducer.ts 等消费方经 config.ts 拿到的就是这一份。
//
// 这三个值在迁移前被 Go 侧 server/config.go 与前端 src/config.ts 各抄一份，
// 同步义务靠 Go 侧测试读前端文件比对后端常量兜底。Go 已随迁移退役，现在
// 声明处只有本文件一处：config.ts 只剩 re-export 行，不含数值字面量，
// 前端与 Worker 读的都是这同一份。

/** 首屏分页条数（与 Worker 侧 defaultLimit 一致） */
export const PAGE_SIZE = 10;

/** 单次请求分页上限（与 Worker 侧 maxLimit 一致） */
export const MAX_LIMIT = 50;

/** 查询输入框最大长度（rune 计，与 Worker 侧 maxQueryRunes 一致） */
export const MAX_QUERY_LENGTH = 80;
