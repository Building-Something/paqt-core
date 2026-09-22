import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GeneratePage } from './GeneratePage';
import { ToastProvider } from '../contexts/ToastContext';
import { UpgradeProvider } from '../components/UpgradeDialog';

const navigateMock = vi.fn();
let beginWithTextMock: ReturnType<typeof vi.fn>;

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('../contexts/EntitlementContext', () => ({
  useEntitlement: () => ({
    usage: {
      signedIn: true,
      status: 'active',
      planId: 'business',
      planName: 'Business',
      periodStart: null,
      periodEnd: null,
      analysis: { used: 0, quota: null, remaining: null },
      draft: { used: 0, quota: null, remaining: null },
      credits: 5,
    },
    loading: false,
    refresh: async () => undefined,
  }),
}));

vi.mock('../contexts/AnalysisContext', () => ({
  useAnalysis: () => ({ beginWithText: beginWithTextMock }),
}));

vi.mock('../components/ContractEditor', () => ({
  ContractEditor: () => <div data-testid="contract-editor" />,
}));

const DRAFT_ENTRY = {
  id: 'draft-test-1',
  kind: 'draft',
  name: 'Test agreement',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  draftBrief: 'A test brief',
  draftMarkdown: '# TEST AGREEMENT\n\n## 1. PARTIES\n\nParty A and Party B.',
  sectionCount: 2,
};

function seedHistory() {
  window.localStorage.setItem('paqt.history.v1', JSON.stringify([DRAFT_ENTRY]));
}

function renderGenerate(path = '/generate') {
  seedHistory();
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <UpgradeProvider>
          <GeneratePage />
        </UpgradeProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GeneratePage', () => {
  it('shows the introduction header on the brief step', () => {
    renderGenerate();
    expect(
      screen.getByRole('heading', { name: 'Draft an agreement in plain English' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/agentic contract drafting/i)).toBeInTheDocument();
  });

  it('opens an existing draft and hides the page header', async () => {
    renderGenerate('/generate?draft=draft-test-1');
    expect(await screen.findByTestId('contract-editor')).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Draft an agreement in plain English' }),
    ).not.toBeInTheDocument();
  });

  it('navigates to /analysis immediately when Analyze for risks is clicked', async () => {
    beginWithTextMock = vi.fn().mockReturnValue(new Promise(() => undefined));
    navigateMock.mockClear();

    renderGenerate('/generate?draft=draft-test-1');
    const user = userEvent.setup();

    expect(await screen.findByTestId('contract-editor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /analyze for risks/i }));

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/analysis');
    });
    expect(beginWithTextMock).toHaveBeenCalledWith(
      'a-test-brief-draft (generated)',
      expect.stringContaining('## 1. PARTIES'),
    );
  });
});