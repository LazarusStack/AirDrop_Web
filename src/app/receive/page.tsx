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
    const ws = new WebSocket('wss://airdropbackend-jv96.onrender.com');
    wsRef.current = ws;

    ws.onopen = () => console.log('✅ WebSocket connected (receiver)');

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      console.log('[Receiver] Received signal:', msg);

      if (msg.type === 'offer') {
        console.log('[TURN Config] Attempting to use TURN server: turn:13.126.43.172:3478');
        const peer = new RTCPeerConnection({
          iceServers: [
            { urls:[
              'stun:stun.l.google.com:19302' ,
              "stun:global.stun.twilio.com:3478"
            ] 
          }, // STUN (for local IP discovery)
          // Try multiple TURN server formats for compatibility
          {
            urls: 'turn:13.126.43.172:3478?transport=udp',
            username: 'turnuser',
            credential: 'turnpassword'
          },
          {
            urls: 'turn:13.126.43.172:3478?transport=tcp',
            username: 'turnuser',
            credential: 'turnpassword'
          },
          {
            urls: 'turn:13.126.43.172:3478',
            username: 'turnuser',
            credential: 'turnpassword'
          }
          ],
        });    
        
        
        peerRef.current = peer;

        let hasRelayCandidate = false;
        let candidateCount = { host: 0, srflx: 0, relay: 0 };

        // Diagnostic: Monitor ICE gathering state
        peer.onicegatheringstatechange = () => {
          console.log(`[ICE Gathering State] ${peer.iceGatheringState}`);
          if (peer.iceGatheringState === 'complete') {
            console.log(`[ICE Candidates Summary] Host: ${candidateCount.host}, STUN: ${candidateCount.srflx}, TURN: ${candidateCount.relay}`);
            if (!hasRelayCandidate) {
              console.warn('⚠️ WARNING: No TURN relay candidates found!');
              console.warn('⚠️ Possible issues:');
              console.warn('   - TURN server may be unreachable');
              console.warn('   - TURN credentials may be incorrect');
              console.warn('   - TURN server may not be running');
              console.warn('   - Firewall may be blocking port 3478');
              console.warn('   - TURN server URL format may be incorrect');
            }
          }
        };

        // Diagnostic: Monitor ICE connection state
        peer.oniceconnectionstatechange = () => {
          console.log(`[ICE State] ${peer.iceConnectionState}`);
          if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
            console.error('❌ ICE connection failed');
            if (!hasRelayCandidate) {
              console.error('❌ TURN server was not used - connection may fail behind NAT/firewall');
            }
          }
          if (peer.iceConnectionState === 'connected' || peer.iceConnectionState === 'completed') {
            if (hasRelayCandidate) {
              console.log('✅ Connected via TURN server');
            } else {
              console.log('✅ Connected (direct or via STUN)');
            }
          }
        };

        // Diagnostic: Monitor connection state
        peer.onconnectionstatechange = () => {
          console.log(`[Connection State] ${peer.connectionState}`);
        };

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

        // Diagnostic: Check ICE candidate types
        peer.onicecandidate = (e) => {
          if (e.candidate) {
            const candidate = e.candidate.candidate;
            const candidateType = e.candidate.type;
            console.log(`[ICE Candidate] Type: ${candidateType}, Candidate: ${candidate}`);
            
            // Track candidate types
            candidateCount[candidateType as keyof typeof candidateCount]++;
            
            // Check if it's a relay candidate (TURN server)
            if (candidateType === 'relay') {
              hasRelayCandidate = true;
              console.log('✅ TURN server is being used (relay candidate found)');
            } else if (candidateType === 'srflx') {
              console.log('ℹ️ Using STUN server (server reflexive candidate)');
            } else if (candidateType === 'host') {
              console.log('ℹ️ Using local candidate');
            }

            ws.send(JSON.stringify({
              type: 'signal',
              room: roomRef.current,
              data: { type: 'ice-candidate', candidate: e.candidate },
            }));
          } else {
            console.log('✅ ICE gathering complete');
            if (!hasRelayCandidate) {
              console.warn('⚠️ No TURN relay candidates were generated');
            }
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
