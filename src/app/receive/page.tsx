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

          const startTime = Date.now();
          let lastLogTime = Date.now();
          
          channel.onmessage = (event) => {
            if (typeof event.data === 'string') {
              const data = JSON.parse(event.data) as DataMessage;
              if (data.type === 'file-meta') {
                fileMeta = data;
                const fileSizeGB = (data.size / 1024 / 1024 / 1024).toFixed(2);
                const chunkSize = 256 * 1024; // Match sender chunk size (256KB)
                setExpectedChunks(Math.ceil(data.size / chunkSize));
                setMessages((m) => [...m, `Receiving: ${fileMeta.name} (${fileSizeGB}GB)`]);
                console.log(`📥 Starting receive: ${fileMeta.name} (${fileSizeGB}GB)`);
              }
              else if (data.type === 'eof') {
                console.log('📥 All chunks received, creating blob...');
                // Uint8Array is compatible with BlobPart, use type assertion to satisfy TypeScript
                const blob = new Blob(receivedChunks as BlobPart[], { type: fileMeta.fileType });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = fileMeta.name;
                a.click();
                URL.revokeObjectURL(a.href);
                const transferTime = ((Date.now() - startTime) / 1000).toFixed(1);
                setMessages((m) => [...m, `✅ File saved (${transferTime}s)`]);
                console.log(`✅ File saved: ${fileMeta.name}`);
              }
            } else {
              // Optimized: push chunk immediately without heavy calculations
              receivedChunks.push(new Uint8Array(event.data));
              
              // Update state less frequently for better performance
              setReceivedChunks(prev => {
                const updated = prev + 1;
                
                // Only calculate progress every 10 chunks to reduce overhead
                if (updated % 10 === 0 || updated === 1) {
                  const totalBytesReceived = receivedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
                  let progressPercent = 0;
                  
                  if (fileMeta && fileMeta.size > 0) {
                    progressPercent = Math.min(100, Math.floor((totalBytesReceived / fileMeta.size) * 100));
                  } else if (expectedChunks > 0) {
                    progressPercent = Math.min(100, Math.floor((updated / expectedChunks) * 100));
                  }
                  
                  setRecvProgress(progressPercent);
                  
                  // Log even less frequently (every 5 seconds or every 100 chunks)
                  const now = Date.now();
                  if ((now - lastLogTime > 5000 || updated % 100 === 0) && (fileMeta && totalBytesReceived >= fileMeta.size || updated % 100 === 0)) {
                    const receivedMB = (totalBytesReceived / 1024 / 1024).toFixed(2);
                    const totalMB = fileMeta ? (fileMeta.size / 1024 / 1024).toFixed(2) : '0';
                    const elapsed = (now - startTime) / 1000;
                    const speed = elapsed > 0 ? (totalBytesReceived / elapsed / 1024 / 1024).toFixed(2) : '0';
                    
                    if (fileMeta && fileMeta.size > 0) {
                      console.log(`📥 ${progressPercent}% - ${receivedMB}MB / ${totalMB}MB @ ${speed}MB/s`);
                    }
                    lastLogTime = now;
                  }
                }
                
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
