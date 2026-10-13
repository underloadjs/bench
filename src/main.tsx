// src/main.tsx — React entry point for the @agentic/bench dev app.
// Vite serves this from index.html; the dashboard paints full-viewport (see
// the html/body height reset in index.html + DashboardShell in BenchDashboard).
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// Mount into the #root element created by index.html
const root = ReactDOM.createRoot(document.getElementById('root')!);

root.render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);