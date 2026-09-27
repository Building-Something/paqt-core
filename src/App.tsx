import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AnalysisProvider } from './contexts/AnalysisContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { PlanProvider } from './contexts/PlanContext';
import { AppShell } from './components/AppShell';
import { RequireAuth } from './components/RequireAuth';
import { RequirePlan } from './components/RequirePlan';
import { DashboardPage } from './pages/DashboardPage';
import { AnalyzeHubPage } from './pages/AnalyzeHubPage';
import { AnalysisPage } from './pages/AnalysisPage';
import { GeneratePage } from './pages/GeneratePage';
import { AboutPage } from './pages/AboutPage';
import { SettingsPage } from './pages/SettingsPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { LandingPage } from './pages/LandingPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { PricingPage } from './pages/PricingPage';
import { AuthPage } from './pages/AuthPage';

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <PlanProvider>
              <SettingsProvider>
                <AnalysisProvider>
                  <Routes>
                    <Route path="/" element={<LandingPage />} />
                    <Route path="/features" element={<FeaturesPage />} />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/privacy" element={<PrivacyPage />} />
                    <Route path="/pricing" element={<PricingPage />} />
                    <Route path="/signin" element={<AuthPage key="signin" mode="signin" />} />
                    <Route path="/signup" element={<AuthPage key="signup" mode="signup" />} />
                    <Route
                      element={
                        <RequireAuth>
                          <AppShell />
                        </RequireAuth>
                      }
                    >
                      <Route path="/dashboard" element={<DashboardPage />} />
                      <Route
                        path="/analysis"
                        element={
                          <RequirePlan>
                            <AnalysisPage />
                          </RequirePlan>
                        }
                      />
                      <Route
                        path="/generate"
                        element={
                          <RequirePlan>
                            <GeneratePage />
                          </RequirePlan>
                        }
                      />
                      <Route
                        path="/analyze"
                        element={
                          <RequirePlan>
                            <AnalyzeHubPage />
                          </RequirePlan>
                        }
                      />
                      <Route path="/settings" element={<SettingsPage />} />
                    </Route>
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AnalysisProvider>
              </SettingsProvider>
            </PlanProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}