import { CallRoom } from '../../../components/CallRoom'

// Next 15: params/searchParams llegan como Promise en Server Components.
export default async function CallPage({
  params,
  searchParams,
}: {
  params: Promise<{ room: string }>
  searchParams: Promise<{ lead?: string; mode?: string }>
}) {
  const { room } = await params
  const { lead, mode } = await searchParams

  return (
    <CallRoom roomName={decodeURIComponent(room)} leadName={lead} mode={mode === 'voice' ? 'voice' : 'shadow'} />
  )
}
