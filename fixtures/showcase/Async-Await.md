# Async-Await

Async-Await 是组织异步控制流的语法。`async` 函数返回 Promise；`await` 等待一个值或 Promise 的结果，并把函数的后续执行安排在之后恢复。

## 暂停的是函数

`await` 不会阻塞整个线程。等待期间，浏览器可以处理其他已准备好的工作。Promise 拒绝会让 `await` 抛出错误，因此可以使用普通的 `try` / `catch`。

```js
async function loadNote(id, signal) {
  const response = await fetch(`/api/notes/${id}`, { signal });
  if (!response.ok) throw new Error('无法读取笔记');
  return await response.json();
}
```

## 顺序与并发由依赖决定

两个操作没有先后依赖时，可以先发起，再一起等待；逐个 `await` 会让后一个操作延迟开始。

```js
const [profile, notes] = await Promise.all([
  loadProfile(),
  loadNotes(),
]);
```

Async-Await 不自动提供取消，也不会取消过期结果的写回。Fetch 可以接收 AbortController 的 signal；界面还应校验请求对应的版本，避免旧响应覆盖新选择。

恢复执行的调度背景见 [[Event Loop]]。
