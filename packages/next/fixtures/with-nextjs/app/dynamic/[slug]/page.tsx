// Next.js 动态路由页面（Next.js 16 params 为 Promise，需 async 访问）
export default async function DynamicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div>
      <h1>Dynamic: {slug}</h1>
      <p>Next.js dynamic route.</p>
    </div>
  );
}
