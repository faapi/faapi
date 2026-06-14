export function GET(db: any) {
  return { connected: db.connected };
}
