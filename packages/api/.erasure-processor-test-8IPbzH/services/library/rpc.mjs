import { TRPCError } from '@trpc/server';
export async function libraryRpc(client, name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) {
        const code = /^LIBRARY_[A-Z_]+$/.test(error.message) ? error.message : 'LIBRARY_UNAVAILABLE';
        throw new TRPCError({ code: 'BAD_REQUEST', message: code });
    }
    return data;
}
