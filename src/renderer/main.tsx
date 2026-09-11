import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider } from '@chakra-ui/react';
import horizonTheme from './theme/horizon';
import App from './App';
import EmployeeApp from './EmployeeApp';
import { LoginGate } from './components/LoginGate';
import { EmployeeWebPanel } from './components/EmployeeWebPanel';
import { installWebApi, isBrowser, getRole } from './webApi';
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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ChakraProvider theme={horizonTheme}>
      {isEmployee ? (
        <EmployeeApp />
      ) : browserMode ? (
        <LoginGate>
          <RoleSwitch />
        </LoginGate>
      ) : (
        <App />
      )}
    </ChakraProvider>
  </React.StrictMode>
);
