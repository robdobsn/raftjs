import RaftConnector from './RaftConnector';
import RaftMicroPythonConsoleClient from './RaftMicroPythonConsoleClient';

function makeClient() {
    const connector = new RaftConnector();
    const sent: string[] = [];
    jest.spyOn(connector.getRaftMsgHandler(), 'sendRICRESTURL').mockImplementation(async (cmd: string) => {
        sent.push(cmd);
        return { rslt: 'ok' } as never;
    });
    return { client: new RaftMicroPythonConsoleClient(connector), sent };
}

describe('RaftMicroPythonConsoleClient.input', () => {
    test('URL-encodes the text and asks the firmware to add the newline', async () => {
        const { client, sent } = makeClient();
        await client.input("print('a & b?', 50%)");
        expect(sent).toEqual(["upy/repl/input?data=print('a%20%26%20b%3F'%2C%2050%25)&newline=1"]);
    });

    test('keeps leading indentation and sends newline=0 when not wanted', async () => {
        const { client, sent } = makeClient();
        await client.input('    x = 1', false);
        expect(sent).toEqual(['upy/repl/input?data=%20%20%20%20x%20%3D%201&newline=0']);
    });

    test('encodes newlines and non-ASCII text', async () => {
        const { client, sent } = makeClient();
        await client.input('@dec\rs = "café"');
        expect(sent).toEqual(['upy/repl/input?data=%40dec%0Ds%20%3D%20%22caf%C3%A9%22&newline=1']);
    });
});
