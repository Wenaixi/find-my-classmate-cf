package main

import "time"

// 后端契约常量：defaultLimit / maxLimit / maxQueryRunes 是前端
// src/shared/contract.ts（跨端契约常量的唯一事实源）的镜像，改动先改那一侧。
// 跨端常量无法跨语言共享，两处各一份，docs/ARCHITECTURE.md 已注明，
// 同步义务由 server/contract_constants_test.go 读该文件对拍兜底。

const (
	// defaultPort 服务监听端口（默认 3078；docker-compose/Dockerfile 的部署端口描述部署形态，不在此收敛）。
	defaultPort = "3078"
	// defaultLimit / maxLimit 分页默认与上限（前端 PAGE_SIZE 同步）。
	defaultLimit = 10
	maxLimit     = 50
	// maxQueryRunes 查询串 rune 上限（前端 MAX_QUERY_LENGTH 同步，App.tsx maxLength 同值）。
	maxQueryRunes = 80
	// rateCapacity / rateInterval 限流令牌桶：突发 capacity / 每秒回补 1 个。
	rateCapacity = 60
	rateInterval = time.Second
	// assetCacheMaxAge 静态资源长缓存头（构建产物哈希命名，immutable）。
	assetCacheMaxAge = "public, max-age=31536000, immutable"
)
