import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import EmployeeApp from './EmployeeApp';
import './styles/index.css';

const isEmployee = new URLSearchParams(window.location.search).get('mode') === 'employee';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isEmployee ? <EmployeeApp /> : <App />}
  </React.StrictMode>
);