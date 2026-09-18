import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

/**
 * 顶部错误边界。
 *
 * 背景：管理端是纯 Web 形态，浏览器里打开的页面一旦在渲染期抛异常（例如某个
 * componentDidMount/useEffect 里访问了不存在的字段），React 会卸载**整棵树**，
 * 用户看到的是一片空白，且控制台之外没有任何提示、也没法自救。
 * 这里兜住异常，给出可读的错误和"重新加载"入口。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, info: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 控制台留痕，便于排障（不要吞掉）
    console.error('[UI ErrorBoundary]', error, info?.componentStack || '');
    this.setState({ info: String(info?.componentStack || '') });
  }

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: '#0b141a',
        color: '#e9edef',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
      }}>
        <div style={{ maxWidth: '720px', width: '100%' }}>
          <h1 style={{ fontSize: '20px', margin: '0 0 12px' }}>页面出现异常</h1>
          <p style={{ color: '#8696a0', margin: '0 0 16px', fontSize: '14px' }}>
            界面已停止渲染，避免显示错误数据。可以尝试重新加载；若反复出现，请把下面的信息发给管理员。
          </p>
          <pre style={{
            background: '#111b21', border: '1px solid #22303c', borderRadius: '8px',
            padding: '12px', fontSize: '12px', overflow: 'auto', maxHeight: '240px',
            color: '#f15c6d', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
          }}>
            {error.message || String(error)}
          </pre>
          {info ? (
            <details style={{ marginTop: '12px', color: '#8696a0', fontSize: '12px' }}>
              <summary style={{ cursor: 'pointer' }}>组件调用栈</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{info}</pre>
            </details>
          ) : null}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '16px', padding: '10px 18px', borderRadius: '8px', border: 'none',
              background: '#00a884', color: '#fff', fontSize: '14px', cursor: 'pointer'
            }}
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
