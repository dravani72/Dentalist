import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Images are fetched through short-lived signed URLs (60 s); the query refreshes the URL
 * before it expires, so a link copied out of the page stops working quickly.
 */
export function Xray({ mediaId, alt, thumb }: { mediaId: string; alt: string; thumb?: boolean }) {
  const url = useQuery({
    queryKey: ['media-url', mediaId],
    queryFn: () => api.get<{ url: string; expiresInSeconds: number }>(`/media/${mediaId}/url`),
    staleTime: 45_000,
    refetchInterval: 45_000,
  });
  if (!url.data) return <span>{thumb ? 'X-ray' : 'Loading image…'}</span>;
  return <img src={url.data.url} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;
}
