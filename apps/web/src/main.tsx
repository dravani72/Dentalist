import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiError } from './lib/api';
import './styles.css';

const queryClient = new QueryClient({
  // A refusal (403, 404, 422…) won't change on a retry; retrying only repeats the denied audit entry.
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: (n, e) => n < 1 && !(e instanceof ApiError && e.status < 500) } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
