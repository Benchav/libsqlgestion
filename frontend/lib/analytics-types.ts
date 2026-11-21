export type AnalyticsRange = 'today' | '7d' | '30d' | 'month';

export type TopQuery = {
  fingerprint: string;
  sqlPreview: string;
  operation?: string;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  avgDurationMs: number;
  maxDurationMs: number;
};

export type OperationUsage = {
  operation: string;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  errors: number;
};

export type TopDatabase = {
  id: string;
  name: string;
  displayName?: string;
  needsRename?: boolean;
  subdomain?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  type?: string;
  status?: string;
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  readQueries: number;
  writeQueries: number;
  otherQueries: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  lastSeenAt: string | null;
  storageBytes: number;
};

export type TopProject = {
  id: string;
  name: string;
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  readQueries: number;
  writeQueries: number;
  errors: number;
  errorRate: number;
};

export type AnalyticsSummary = {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  errors: number;
  errorRate: number;
  readQueries: number;
  writeQueries: number;
  otherQueries: number;
  readWriteRatio: number | null;
  rowsReadPerQuery: number;
  rowsWrittenPerWrite: number;
  queriesPerHour: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  storageBytes: number;
  trafficInBytes: number;
  trafficOutBytes: number;
  requests: number;
  activeDatabases: number;
  totalDatabases: number;
  syncs: null;
};

export type AnalyticsSeries = {
  labels: string[];
  queries: number[];
  errors: number[];
  readQueries: number[];
  writeQueries: number[];
  rowsRead: number[];
  rowsWritten: number[];
  latencyAvg: Array<number | null>;
  latencyP95: Array<number | null>;
  latencyMax: Array<number | null>;
  trafficIn: number[];
  trafficOut: number[];
  requests: number[];
  storage: number[];
};

export type AnalyticsSource = {
  source: string;
  queries: number;
  errors: number;
  avgDurationMs: number;
};

export type StatusCodeUsage = {
  statusCode: number;
  requests: number;
  responseBytes: number;
};

export type TopError = {
  errorCode: string;
  queries: number;
  sqlPreview: string;
  lastSeenAt: string | null;
};

export type AnalyticsOverview = {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  summary: AnalyticsSummary;
  series: AnalyticsSeries;
  sources: AnalyticsSource[];
  statusCodes: StatusCodeUsage[];
  operations: OperationUsage[];
  topDatabases: TopDatabase[];
  topProjects: TopProject[];
  topQueries: TopQuery[];
  topQueriesByRowsRead: TopQuery[];
  topQueriesByRowsWritten: TopQuery[];
  topQueriesByFrequency: TopQuery[];
  topErrors: TopError[];
};

export type DashboardAnalytics = {
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  summary: AnalyticsSummary;
  series: AnalyticsSeries;
  operations: OperationUsage[];
  topDatabases: TopDatabase[];
};
