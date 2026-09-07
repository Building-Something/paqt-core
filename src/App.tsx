import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AnalysisProvider } from './contexts/AnalysisContext';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { AnalyzeHubPage } from './pages/AnalyzeHubPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { GeneratePage } from './pages/GeneratePage';
import { AboutPage } from './pages/AboutPage';
import { PrivacyPage } from './pages/PrivacyPage';

export default function App() {
  return (
    <BrowserRouter>
      <AnalysisProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
            <Route path="/generate" element={<GeneratePage />} />
            <Route path="/analyze" element={<AnalyzeHubPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="*" element={<DashboardPage />} />
          </Route>
        </Routes>
      </AnalysisProvider>
    </BrowserRouter>
  );
}