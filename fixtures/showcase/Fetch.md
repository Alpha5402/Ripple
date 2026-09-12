# Fetch

Fetch 提供浏览器中的网络请求接口。`fetch()` 返回 Promise，在响应头可用时兑现为 `Response`；正文还可以继续被读取。

## 状态码与失败

HTTP 404 或 500 通常仍会得到一个正常的 Response。业务代码需要检查 `response.ok` 或状态码；网络层失败与 HTTP 错误响应应分别处理。

```js
const response = await fetch('/api/notes');
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const notes = await response.json();
```

## 正文可以渐进消费

`response.body` 是可读流，可以逐段处理数据。与一次性把所有内容读入内存相比，Streams API 提供了按块消费的方式。

AbortController 可以用于中止支持该信号的请求及正文消费。界面在重新发起请求时，仍应避免旧结果覆盖当前页面状态。

网络任务的完成与回调执行之间，还隔着 JavaScript 的调度机制。可结合 [[Promise]] 与 [[Event Loop]] 理解。
