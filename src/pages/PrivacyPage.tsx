import { Link } from 'react-router-dom';
import { ArrowRight, Server, ScanSearch, Shield } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';

export function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-14">
      <Link
        to="/dashboard"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
      >
        <ArrowRight className="size-4 rotate-180" aria-hidden="true" />
        Back to dashboard
      </Link>

      <h1 className="mt-6 text-4xl font-semibold tracking-tight text-foreground">
        Privacy model
      </h1>
      <p className="mt-4 text-base leading-relaxed text-muted-foreground">
        Paqt is designed to be transparent about how your document is handled.
        Here is what the MVP actually does.
      </p>

      <div className="mt-8 space-y-4">
        <Card>
          <CardContent className="flex items-start gap-4 p-6">
            <div className="rounded-lg bg-muted p-2 text-primary">
              <ScanSearch className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Extraction happens in your browser
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                When you upload a PDF, Paqt reads the text inside it using your
                browser. The file is not uploaded to Paqt’s server for extraction.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-start gap-4 p-6">
            <div className="rounded-lg bg-muted p-2 text-primary">
              <Server className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">
                Analysis goes through Paqt’s server
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                The extracted contract text is sent to Groq through Paqt’s server
                proxy for analysis. Your API credentials stay server-side and are
                never exposed to the browser.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-start gap-4 p-6">
            <div className="rounded-lg bg-muted p-2 text-primary">
              <Shield className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">
                No permanent storage
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                This MVP does not use a database and does not promise permanent
                storage of your documents or analyses. Reloading or moving to a
                new device clears in-memory analysis state.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="mt-8 rounded-lg border border-border bg-card px-5 py-4 text-sm leading-relaxed text-muted-foreground">
        Paqt applies this privacy model today, but the future roadmap includes
        optional saved sessions and team workspaces. Any changes to how data is
        stored or shared will update this page before rollout.
      </p>
    </div>
  );
}