import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AnalysisProgress,
  ChatMessage,
  ContractAnalysis,
  ContractRisk,
  PdfPage,
  ProgressStage,
} from '../types';
import { extractContractText, extractPdfText } from '../services/pdfService';
import { analyzePages, chatWithContract } from '../services/groqService';
import { GroqServiceError } from '../services/errors';
import { groqErrorMessage, type GroqErrorCode } from '../utils/risks';
import { buildDraftPages, splitDraftIntoSections } from '../utils/draft';
import {
  createHistoryId,
  upsertHistoryEntry,
  getHistoryEntry,
  type HistoryEntry,
} from '../services/historyService';

export interface AnalysisError {
  code: GroqErrorCode;
  message: string;
  retriable: boolean;
}

interface AnalysisContextValue {
  file: File | null;
  fileName: string;
  pages: PdfPage[];
  contractText: string;
  draftMarkdown: string;
  isDraft: boolean;
  analysis: ContractAnalysis | null;
  record: HistoryEntry | null;
  selectedRisk: ContractRisk | null;
  chatMessages: ChatMessage[];
  progress: AnalysisProgress;
  error: AnalysisError | null;
  isChatBusy: boolean;
  currentPage: number;
  totalPages: number;
  beginAnalysis: (file: File) => Promise<void>;
  beginWithText: (sessionName: string, markdown: string) => Promise<void>;
  retryAnalysis: () => Promise<void>;
  openEntry: (id: string) => Promise<void>;
  selectRisk: (risk: ContractRisk | null) => void;
  setCurrentPage: (page: number) => void;
  sendMessage: (text: string) => Promise<void>;
  reset: () => void;
}

const RETRIABLE_CODES: GroqErrorCode[] = [
  'rate_limited',
  'timeout',
  'upstream',
  'network',
  'invalid_json',
];

const AnalysisContext = createContext<AnalysisContextValue | null>(null);

function makeProgress(stage: ProgressStage, label: string, pageRange?: string): AnalysisProgress {
  return { stage, label, pageRange };
}

function createId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `${prefix}-${random}`;
}

const KNOWN_CODES: GroqErrorCode[] = [
  'not_configured',
  'invalid_key',
  'rate_limited',
  'timeout',
  'upstream',
  'bad_request',
  'oversized',
  'invalid_json',
  'network',
  'unknown',
];

function toErrorMessage(error: unknown): AnalysisError {
  if (error instanceof GroqServiceError) {
    const code: GroqErrorCode = KNOWN_CODES.includes(error.code as GroqErrorCode)
      ? (error.code as GroqErrorCode)
      : 'unknown';
    return {
      code,
      message: groqErrorMessage(code),
      retriable: RETRIABLE_CODES.includes(code),
    };
  }
  if (error instanceof Error && error.message.includes('Failed to extract text')) {
    return {
      code: 'unknown',
      message: 'Paqt could not reliably extract text from this PDF.',
      retriable: false,
    };
  }
  return {
    code: 'unknown',
    message: 'Something went wrong while analyzing this contract. Please try again.',
    retriable: true,
  };
}

interface AnalysisProviderProps {
  children: ReactNode;
}

export function AnalysisProvider({ children }: AnalysisProviderProps) {
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [pages, setPages] = useState<PdfPage[]>([]);
  const [contractText, setContractText] = useState('');
  const [draftMarkdown, setDraftMarkdown] = useState('');
  const [analysis, setAnalysis] = useState<ContractAnalysis | null>(null);
  const [selectedRisk, setSelectedRisk] = useState<ContractRisk | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [progress, setProgress] = useState<AnalysisProgress>(
    makeProgress('idle', ''),
  );
  const [error, setError] = useState<AnalysisError | null>(null);
  const [isChatBusy, setIsChatBusy] = useState(false);
  const [currentPage, setCurrentPageState] = useState(1);
  const [record, setRecord] = useState<HistoryEntry | null>(null);
  const totalPages = pages.length;

  const runningRef = useRef(false);
  const sourceNameRef = useRef('');
  const isDraftRef = useRef(false);
  const draftMarkdownRef = useRef('');

  const reset = useCallback(() => {
    runningRef.current = false;
    sourceNameRef.current = '';
    isDraftRef.current = false;
    draftMarkdownRef.current = '';
    setRecord(null);
    setFile(null);
    setDisplayName('');
    setPages([]);
    setContractText('');
    setDraftMarkdown('');
    setAnalysis(null);
    setSelectedRisk(null);
    setChatMessages([]);
    setProgress(makeProgress('idle', ''));
    setError(null);
    setCurrentPageState(1);
    setIsChatBusy(false);
  }, []);

  const selectRisk = useCallback((risk: ContractRisk | null) => {
    setSelectedRisk(risk);
  }, []);

  const runAnalysis = useCallback(
    async (givenFile: File | null, givenPages: PdfPage[] | null) => {
      runningRef.current = true;
      setError(null);

      try {
        let workingPages = givenPages;
        if (!workingPages) {
          if (!givenFile) {
            throw new Error('No file.');
          }
          setProgress(makeProgress('extracting', 'Extracting contract text…'));
          const extracted = await extractPdfText(givenFile);
          const hasAnyText = extracted.some((page) => page.text.trim().length > 0);
          if (extracted.length === 0 || !hasAnyText) {
            throw new Error('Failed to extract text from PDF.');
          }
          workingPages = extracted;
          setPages(extracted);
        }

        setProgress(makeProgress('preparing', 'Preparing pages…'));
        const text = await extractContractText(workingPages);
        setContractText(text);

        const completedAnalysis = await analyzePages(workingPages, (label, stage, detail) => {
          setProgress(
            makeProgress(
              stage,
              label,
              detail ? `${detail.from}-${detail.to}` : undefined,
            ),
          );
        });

        if (!runningRef.current) {
          return;
        }
        setAnalysis(completedAnalysis);
        setProgress(makeProgress('complete', 'Analysis complete'));
        const entry: HistoryEntry = {
          id: createHistoryId('analysis'),
          kind: 'analysis',
          name: sourceNameRef.current || 'Contract analysis',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          analysis: completedAnalysis,
          pageCount: isDraftRef.current ? undefined : workingPages.length,
          draftMarkdown: isDraftRef.current ? draftMarkdownRef.current : undefined,
        };
        upsertHistoryEntry(entry);
      } catch (caught) {
        if (!runningRef.current) {
          return;
        }
        const mapped = toErrorMessage(caught);
        setError(mapped);
        setProgress(makeProgress('error', mapped.message));
      } finally {
        runningRef.current = false;
      }
    },
    [],
  );

  const beginAnalysis = useCallback(
    async (givenFile: File) => {
      reset();
      sourceNameRef.current = givenFile.name;
      isDraftRef.current = false;
      draftMarkdownRef.current = '';
      setFile(givenFile);
      await runAnalysis(givenFile, null);
    },
    [reset, runAnalysis],
  );

  const beginWithText = useCallback(
    async (sessionName: string, markdown: string) => {
      reset();
      const sections = splitDraftIntoSections(markdown);
      if (sections.length === 0) {
        setError({
          code: 'unknown',
          message: 'Could not structure this draft for analysis. Please try again.',
          retriable: true,
        });
        setProgress(makeProgress('error', 'Could not structure this draft for analysis.'));
        return;
      }
      const draftPages = buildDraftPages(sections);
      sourceNameRef.current = sessionName.trim() || 'Generated draft';
      isDraftRef.current = true;
      draftMarkdownRef.current = markdown;
      setPages(draftPages);
      setDraftMarkdown(markdown);
      setDisplayName(sourceNameRef.current);
      await runAnalysis(null, draftPages);
    },
    [reset, runAnalysis],
  );

  const openEntry = useCallback(
    async (id: string) => {
      const entry = getHistoryEntry(id);
      if (!entry || entry.kind !== 'analysis' || !entry.analysis) {
        return;
      }
      if (entry.draftMarkdown) {
        await beginWithText(entry.name, entry.draftMarkdown);
        return;
      }
      reset();
      setRecord(entry);
      setAnalysis(entry.analysis);
    },
    [beginWithText, reset],
  );

  const retryAnalysis = useCallback(async () => {
    await runAnalysis(file, pages.length > 0 ? pages : null);
  }, [file, pages, runAnalysis]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !analysis || isChatBusy) {
        return;
      }
      const userMessage: ChatMessage = {
        id: createId('msg'),
        text: trimmed,
        sender: 'user',
        timestamp: new Date(),
      };
      setChatMessages((messages) => [...messages, userMessage]);
      setIsChatBusy(true);

      try {
        const reply = await chatWithContract(trimmed, contractText, analysis);
        const aiMessage: ChatMessage = {
          id: createId('msg'),
          text: reply,
          sender: 'ai',
          timestamp: new Date(),
        };
        setChatMessages((messages) => [...messages, aiMessage]);
      } catch (caught) {
        const mapped = toErrorMessage(caught);
        const aiMessage: ChatMessage = {
          id: createId('msg'),
          text: mapped.message,
          sender: 'ai',
          timestamp: new Date(),
        };
        setChatMessages((messages) => [...messages, aiMessage]);
      } finally {
        setIsChatBusy(false);
      }
    },
    [analysis, contractText, isChatBusy],
  );

  const setCurrentPage = useCallback((page: number) => {
    setCurrentPageState(page);
  }, []);

  const value = useMemo<AnalysisContextValue>(
    () => ({
      file,
      fileName: file?.name ?? displayName,
      pages,
      contractText,
      draftMarkdown,
      isDraft: file === null && pages.length > 0,
      analysis,
      record,
      selectedRisk,
      chatMessages,
      progress,
      error,
      isChatBusy,
      currentPage,
      totalPages,
      beginAnalysis,
      beginWithText,
      retryAnalysis,
      openEntry,
      selectRisk,
      setCurrentPage,
      sendMessage,
      reset,
    }),
    [
      file,
      displayName,
      pages,
      contractText,
      draftMarkdown,
      analysis,
      record,
      selectedRisk,
      chatMessages,
      progress,
      error,
      isChatBusy,
      currentPage,
      totalPages,
      beginAnalysis,
      beginWithText,
      retryAnalysis,
      openEntry,
      selectRisk,
      setCurrentPage,
      sendMessage,
      reset,
    ],
  );

  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>;
}

export function useAnalysis(): AnalysisContextValue {
  const context = useContext(AnalysisContext);
  if (!context) {
    throw new Error('useAnalysis must be used within an AnalysisProvider');
  }
  return context;
}