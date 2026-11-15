// 跨端契约常量（PAGE_SIZE / MAX_LIMIT / MAX_QUERY_LENGTH）的单一 owner，
// 前端与 Worker 一律从本文件取值：src/config.ts 直接 re-export 本文件，
// App.tsx、lib/searchReducer.ts 等消费方经 config.ts 拿到的就是这一份。
//
// 这三个值此前被 Go 侧 server/config.go 与前端 src/config.ts 各抄一份，
// 同步义务靠 server/contract_constants_test.go 读前端文件比对后端常量兜底。
// 收口到本文件后，声明处只有一处；config.ts 只剩 re-export 行，不含数值字面量，
// 因此跨语言对拍读取的是本文件——Go 端的 defaultLimit / maxLimit /
// maxQueryRunes 是镜像，改动请先改本文件，再去同步 server/config.go。

/** 首屏分页条数（与后端 defaultLimit 对拍一致） */
export const PAGE_SIZE = 10;

/** 单次请求分页上限（与后端 maxLimit 对拍一致） */
export const MAX_LIMIT = 50;

/** 查询输入框最大长度（rune 计，与后端 maxQueryRunes 对拍一致） */
export const MAX_QUERY_LENGTH = 80;
