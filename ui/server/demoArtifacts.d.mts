export declare function isSafeDemoSlug(slug: string): boolean;
export declare function buildDemoReceiptSvg(input: {
  slug: string;
  title: string;
  company: string;
  submittedAt: string;
}): string;
export declare function persistDemoScores(root: string): number;
export declare function commitDemoApplication(
  root: string,
  slug: string,
  options?: { injectFailureAfter?: "applied" | "screenshot" | "state" | "queue" },
): { screenshotRel: string; appliedPath: string };
