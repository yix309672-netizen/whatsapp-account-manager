import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider } from '@chakra-ui/react';
import horizonTheme from './theme/horizon';
import App from './App';
import EmployeeApp from './EmployeeApp';
import { LoginGate } from './components/LoginGate';
import { installWebApi, isBrowser } from './webApi';
import './styles/index.css';

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
          <App />
        </LoginGate>
      ) : (
        <App />
      )}
    </ChakraProvider>
  </React.StrictMode>
);
