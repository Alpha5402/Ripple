# AbortController

AbortController 提供一个取消信号：控制方调用 `abort()`，支持该信号的操作观察到中止后结束工作。

## 取消与过期是两件事

在搜索输入变化时，旧请求可能已经不再有用。中止旧请求可以减少浪费，但结果写回仍应校验它是否属于当前输入。

```js
let controller;
let version = 0;
async function search(query) {
  controller?.abort();
  controller = new AbortController();
  const current = ++version;
  try {
    const response = await fetch(`/search?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
    });
    const result = await response.json();
    if (current === version) render(result);
  } catch (error) {
    if (current === version && error.name !== 'AbortError') showError(error);
  }
}
```

## 取消是一种协作

并非所有操作都支持中止。信号也不能把已经产生的外部副作用自动撤销。设计接口时，需要同时考虑资源清理、错误传播，以及晚到结果是否仍有执行权。

已经中止的 signal 不能复用成一次新的未中止请求，应为新的生命周期创建新的控制器。
