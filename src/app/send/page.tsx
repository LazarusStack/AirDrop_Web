'use client';
import { useEffect, useRef, useState } from 'react';

export default function SendPage() {
  const wsRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const roomRef = useRef('');
  const [room, setRoom] = useState('');
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState(0);


  useEffect(() => {
    const ws = new WebSocket('wss://airdropbackend-jv96.onrender.com');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('✅ WebSocket connected (sender)');
    };

    ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);
        console.log('[Sender] Received message:', msg);
      
        if (msg.type === 'peer-joined') {
          console.log('[Sender] Receiver has joined! Creating offer...');
          startConnection(room); // ✅ Now it's safe to start connection
        }
      
        if (msg.type === 'answer') {
          await peerRef.current?.setRemoteDescription(new RTCSessionDescription(msg.answer));
        }
      
        if (msg.type === 'ice-candidate') {
          await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ✅ run once

  const createRoom = () => {
    const roomCode = Math.random().toString(36).substring(2, 8);
    setRoom(roomCode);
  
    const waitForWebSocket = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'join', room: roomCode }));
        startConnection(roomCode);
      } else {
        setTimeout(waitForWebSocket, 100); // Check again after 100ms
      }
    };
  
    waitForWebSocket();
  };
  

  const startConnection = async (roomCode: string) => {
    console.log('[TURN Config] Attempting to use TURN server: turn:13.126.43.172:3478');
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls:[
          'stun:stun.l.google.com:19302' ,
          "stun:global.stun.twilio.com:3478"
        ] 
      },
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

        wsRef.current?.send(JSON.stringify({
          type: 'signal',
          room: roomCode,
          data: { type: 'ice-candidate', candidate: e.candidate },
        }));
      } else {
        console.log('✅ ICE gathering complete');
        if (!hasRelayCandidate) {
          console.warn('⚠️ No TURN relay candidates were generated');
        }
      }
    };

    const channel = peer.createDataChannel('file');
    dataChannelRef.current = channel;

    channel.onopen = () => {
      console.log('[DataChannel] Open (sender)');
      setConnected(true);
    };

    channel.onerror = (e) => console.error('DataChannel error (sender):', e);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    wsRef.current?.send(JSON.stringify({
      type: 'signal',
      room: roomRef.current,
      data: { type: 'offer', offer },
    }));
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const dataChannel = dataChannelRef.current;
  
    if (!file || !dataChannel || dataChannel.readyState !== 'open') return;

    // Check file size (10GB limit)
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
    if (file.size > MAX_FILE_SIZE) {
      alert(`File size (${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB) exceeds the 10GB limit`);
      return;
    }

    // Optimized for maximum speed - large chunks and aggressive buffering
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks for maximum throughput
    const MAX_BUFFER = 16 * 1024 * 1024; // 16MB buffer - aggressive for speed
    const LOW_WATER_MARK = 8 * 1024 * 1024; // 8MB low water mark
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let sentChunks = 0;

    console.log(`📤 Starting transfer: ${file.name} (${(file.size / 1024 / 1024 / 1024).toFixed(2)}GB)`);

    // Set the low water mark threshold
    dataChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;
  
    // Send file metadata
    try {
      dataChannel.send(JSON.stringify({
        type: 'file-meta',
        name: file.name,
        size: file.size,
        fileType: file.type,
      }));
    } catch (err) {
      console.error('🚫 Failed to send file metadata:', err);
      return;
    }
  
    let offset = 0;
    const startTime = Date.now();
  
    const waitForDrain = (): Promise<void> => {
      return new Promise<void>((resolve) => {
        // Check if buffer is already low - fast path
        if (dataChannel.bufferedAmount < LOW_WATER_MARK) {
          resolve();
          return;
        }
        
        // Poll buffer amount instead of waiting for event (faster)
        const checkBuffer = () => {
          if (dataChannel.bufferedAmount < LOW_WATER_MARK) {
            resolve();
          } else {
            // Check every 10ms for faster response
            setTimeout(checkBuffer, 10);
          }
        };
        checkBuffer();
      });
    };
  
    // Optimized send loop - batch reads and sends for maximum speed
    while (offset < file.size) {
      // Quick buffer check - only wait if really full
      if (dataChannel.bufferedAmount > MAX_BUFFER) {
        await waitForDrain();
      }
      
      // Read chunk (non-blocking)
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      const uint8Buffer = new Uint8Array(buffer);
  
      // Send immediately without extra checks (faster)
      try {
        if (dataChannel.readyState !== 'open') {
          console.error('❌ DataChannel closed during send');
          return;
        }
        
        dataChannel.send(uint8Buffer);
      } catch (err: any) {
        // Only retry on queue full error
        if (err.name === 'OperationError' && err.message?.includes('queue is full')) {
          await waitForDrain();
          // Retry once
          try {
            dataChannel.send(uint8Buffer);
          } catch (retryErr) {
            console.error('🚫 Send failed after retry:', retryErr);
            return;
          }
        } else {
          console.error('🚫 Send failed:', err);
          return;
        }
      }
  
      offset += CHUNK_SIZE;
      sentChunks++;
      
      // Update progress less frequently to reduce overhead (every 50 chunks)
      if (sentChunks % 50 === 0 || offset >= file.size) {
        const progressPercent = Math.floor((sentChunks / totalChunks) * 100);
        setProgress(progressPercent);
        
        // Log even less frequently (every 200 chunks or 5 seconds)
        if (sentChunks % 200 === 0 || offset >= file.size) {
          const sentMB = (offset / 1024 / 1024).toFixed(2);
          const totalMB = (file.size / 1024 / 1024).toFixed(2);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? (offset / elapsed / 1024 / 1024).toFixed(2) : '0';
          console.log(`📦 ${progressPercent}% - ${sentMB}MB / ${totalMB}MB @ ${speed}MB/s`);
        }
      }
    }
  
    // Wait for buffer to drain before sending EOF
    if (dataChannel.bufferedAmount > 0) {
      console.log('⏳ Waiting for final buffer drain before EOF...');
      await waitForDrain();
    }
  
    try {
      dataChannel.send(JSON.stringify({ type: 'eof' }));
      console.log('✅ File send complete');
    } catch (err) {
      console.error('🚫 Failed to send EOF:', err);
    }
  };
  
  

  return (
    <div className="p-6 text-center">
      <h2 className="text-2xl font-bold mb-4">Send File</h2>
      {room ? <p className="mb-2">Room Code: <code>{room}</code></p> : (
        <button onClick={createRoom} className="px-4 py-2 bg-blue-500 text-white rounded-xl">Create Room</button>
      )}
      {connected ? (<>
        <input 
          type="file" 
          onChange={handleFile} 
          className="block mx-auto mt-6" 
          accept="*/*"
        />
        <p className="text-xs text-gray-500 mt-2">Supports files up to 10GB</p>
        {progress > 0 && progress < 100 && (
          <div className="mt-4">
            <div className="w-full bg-gray-200 rounded-full h-4">
              <div
                className="bg-blue-500 h-4 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 mt-2">{progress}%</p>
          </div>
        )}
        {progress === 100 && <p className="mt-2 text-green-600">✅ File Sent</p>}
        </>
        
      ) : (
        <p className="text-sm text-gray-500 mt-6">Waiting for connection...</p>
      )}
    </div>
  );
}
