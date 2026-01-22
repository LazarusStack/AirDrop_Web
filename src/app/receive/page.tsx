'use client';
import { useEffect, useRef, useState } from 'react';

export default function ReceivePage() {
  const wsRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const roomRef = useRef(''); // 💡 fix here
  const [room, setRoom] = useState('');
  const [inputRoom, setInputRoom] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const [recvProgress, setRecvProgress] = useState(0);
  const [expectedChunks, setExpectedChunks] = useState(0);
  const [receivedChunks, setReceivedChunks] = useState(0);


  interface FileMeta {
    type: 'file-meta';
    name: string;
    size: number;
    fileType: string;
  }

  type DataMessage = 
  | FileMeta
  | { type: 'eof' };

  const joinRoom = () => {
    setRoom(inputRoom);
    roomRef.current = inputRoom; // ✅ store in ref
    wsRef.current?.send(JSON.stringify({ type: 'join', room: inputRoom }));
  };

  useEffect(() => {
    const ws = new WebSocket('wss://airdropbackend-production.up.railway.app');
    wsRef.current = ws;

    ws.onopen = () => console.log('✅ WebSocket connected (receiver)');

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      console.log('[Receiver] Received signal:', msg);

      if (msg.type === 'offer') {
        const peer = new RTCPeerConnection({
          iceServers: [
            { urls:[
              'stun:stun.l.google.com:19302' ,
              "stun:global.stun.twilio.com:3478"
            ] 
          }, // STUN (for local IP discovery)
          {
            urls: 'turn:13.232.240.127:3478',
            username: 'turnuser',
            credential: 'turnpassword'
          }
          ],
        });    
        
        
        peerRef.current = peer;

        peer.ondatachannel = (e) => {
          const channel = e.channel;
          console.log('[Receiver] DataChannel received');
          const receivedChunks: Uint8Array[] = [];
          let fileMeta: FileMeta ;

          channel.onmessage = (event) => {
            if (typeof event.data === 'string') {
              const data = JSON.parse(event.data) as DataMessage;
              if (data.type === 'file-meta') {
                fileMeta = data;
                setMessages((m) => [...m, `Receiving: ${fileMeta.name}`]);
                setExpectedChunks(Math.ceil(data.size / (64 * 1024))); // 64KB chunks
              }
              else if (data.type === 'eof') {
                const blob = new Blob([new Uint8Array(receivedChunks.flatMap(chunk => Array.from(chunk)))], { type: fileMeta.fileType });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = fileMeta.name;
                a.click();
                setMessages((m) => [...m, `✅ File saved`]);
              }
            } else {
              receivedChunks.push(new Uint8Array(event.data));
              console.log(`[Receiver] Chunk received (${event.data.byteLength} bytes)`);
              setReceivedChunks(prev => {
                const updated = prev + 1;
                setRecvProgress(Math.floor((updated / expectedChunks) * 100));
                return updated;
              });
            }
          };

          channel.onerror = (e) => console.error('DataChannel error (receiver):', e);
        };

        peer.onicecandidate = (e) => {
          if (e.candidate) {
            ws.send(JSON.stringify({
              type: 'signal',
              room: roomRef.current,
              data: { type: 'ice-candidate', candidate: e.candidate },
            }));
          }
        };

        await peer.setRemoteDescription(new RTCSessionDescription(msg.offer));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        ws.send(JSON.stringify({
          type: 'signal',
          room: roomRef.current,
          data: { type: 'answer', answer },
        }));
      }

      if (msg.type === 'ice-candidate') {
        await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
      }
    };
  }, []); // ✅ no dependency on room

  return (
    <div className="p-6 text-center">
      <h2 className="text-2xl font-bold mb-4">Receive File</h2>
      {room ? <p>Joined Room: <code>{room}</code></p> : (
        <div className="space-y-4">
          <input
            placeholder="Enter Room Code"
            value={inputRoom}
            onChange={(e) => setInputRoom(e.target.value)}
            className="px-3 py-2 border rounded-xl"
          />
          <button onClick={joinRoom} className="px-4 py-2 bg-green-600 text-white rounded-xl">Join</button>
        </div>
      )}
      <ul className="text-left max-w-md mx-auto mt-4">
        {messages.map((msg, i) => (
          <li key={i}>📥 {msg}</li>
        ))}
      </ul>
      {expectedChunks > 0 && recvProgress < 100 && (
        <div className="w-full bg-gray-200 rounded-full h-4 mt-4 relative max-w-md mx-auto">
          <div
            className="bg-green-500 h-4 rounded-full transition-all duration-300"
            style={{ width: `${recvProgress}%` }}
          />
          <p className="absolute inset-0 flex items-center justify-center text-xs font-medium text-black">
            {recvProgress}%
          </p>
        </div>
      )}

      {recvProgress === 100 && (
        <p className="mt-4 text-green-600 font-semibold">✅ File Received{receivedChunks}</p>
)}


    </div>
  );
}
