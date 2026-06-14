export interface POSTBody {
  name: string;
  email: string;
}

export function POST(body: POSTBody) {
  return { name: body.name, email: body.email };
}
