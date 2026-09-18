import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider } from '@chakra-ui/react';
import horizonTheme from './theme/horizon';
import App from './App';
import EmployeeApp from './EmployeeApp';
import { LoginGate } from './components/LoginGate';
import { EmployeeWebPanel } from './components/EmployeeWebPanel';
import { installWebApi, isBrowser, getRole } from './webApi';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/index.css';

// 登录后按角色分流：员工只进自己的账号页，看不到管理功能
function RoleSwitch(): React.JSX.Element {
  const role = (() => { try { return getRole(); } catch { return 'admin'; } })();
  return role === 'employee' ? <EmployeeWebPanel /> : <App />;
}

const isEmployee = new URLSearchParams(window.location.search).get('mode') === 'employee';
const browserMode = isBrowser();

// 浏览器环境（Web 管理后台）需先安装 WS 版 window.api，再进入登录门禁
if (browserMode) {
  installWebApi();
}

// ⚠️ 顺序很重要：browserMode 必须优先于 isEmployee。
// EmployeeApp 是"员工桌面端"的界面，会同步调用 window.api.employee.status()，
// 而浏览器版 window.api 并没有这个方法 —— 在浏览器里带 ?mode=employee 打开会直接
// TypeError 卸载整棵树（整页白屏）。现在浏览器一律走 LoginGate + RoleSwitch，
// 员工在浏览器里登录后由 RoleSwitch 分流到 EmployeeWebPanel（Web 版员工面板）。
const view = browserMode ? (
  <LoginGate>
    <RoleSwitch />
  </LoginGate>
) : isEmployee ? (
  <EmployeeApp />
) : (
  <App />
);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ChakraProvider theme={horizonTheme}>
        {view}
      </ChakraProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
