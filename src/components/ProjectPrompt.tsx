import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { TeamSurvey } from "../domain/types";
import { VoiceBeam, useMicrophone } from "../vendor/voice-glow";

interface WebSpeechAlternative { transcript: string }
interface WebSpeechResult {
  readonly isFinal: boolean;
  readonly 0: WebSpeechAlternative;
}
interface WebSpeechResultEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<WebSpeechResult>;
}
interface WebSpeechErrorEvent { readonly error: string }
interface WebSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: WebSpeechResultEvent) => void) | null;
  onerror: ((event: WebSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type WebSpeechConstructor = new () => WebSpeechRecognition;

function getWebSpeechConstructor(): WebSpeechConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as Window & {
    SpeechRecognition?: WebSpeechConstructor;
    webkitSpeechRecognition?: WebSpeechConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export interface ProjectPromptSubmission {
  projectDescription: string;
  survey: TeamSurvey;
}

export interface ProjectIdea {
  id: string;
  title: string;
  description: string;
  teamFit: string;
  demonstration: string;
}

export interface PlanningModelOption {
  slug: string;
  displayName: string;
}

export interface ProjectPromptProps {
  survey: TeamSurvey;
  projectDescription: string;
  onSurveyChange: (survey: TeamSurvey) => void;
  onDescriptionChange: (description: string) => void;
  audioMemo: Blob | null;
  onAudioMemoChange: (memo: Blob | null) => void;
  ideas: ProjectIdea[];
  isSuggestingIdeas: boolean;
  ideaError: string;
  onSuggestIdeas: () => void;
  models: PlanningModelOption[];
  selectedModel: string;
  recommendedModelSlug: string | null;
  modelMessage: string;
  onModelChange: (model: string) => void;
  onGenerate: (submission: ProjectPromptSubmission) => void;
  onBack: () => void;
  isGenerating?: boolean;
}

export default function ProjectPrompt({
  survey,
  projectDescription,
  onSurveyChange,
  onDescriptionChange,
  audioMemo,
  onAudioMemoChange,
  ideas,
  isSuggestingIdeas,
  ideaError,
  onSuggestIdeas,
  models,
  selectedModel,
  recommendedModelSlug,
  modelMessage,
  onModelChange,
  onGenerate,
  onBack,
  isGenerating = false,
}: ProjectPromptProps) {
  const hasDescription = projectDescription.trim().length > 0;
  const modelReady = models.some((model) => model.slug === selectedModel);
  const microphone = useMicrophone({ autoStart: false });
  const microphoneBusy = microphone.state === "requesting";
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<WebSpeechRecognition | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);
  const baseTextRef = useRef("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingError, setRecordingError] = useState("");
  const [speechError, setSpeechError] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [selectedIdeaId, setSelectedIdeaId] = useState("");

  useEffect(() => {
    if (!audioMemo) {
      setAudioUrl("");
      return;
    }
    const nextUrl = URL.createObjectURL(audioMemo);
    setAudioUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [audioMemo]);

  useEffect(() => {
    setSelectedIdeaId("");
  }, [ideas]);

  useEffect(() => {
    if (microphone.state === "denied") {
      setRecordingError("Microphone access was denied. Check browser permissions and retry.");
    } else if (microphone.state === "unsupported") {
      setRecordingError("This browser cannot access a microphone.");
    } else if (microphone.state === "error") {
      setRecordingError("The microphone could not start. Check browser permissions and input device.");
    }
  }, [microphone.state]);

  useEffect(() => () => {
    recognitionRef.current?.abort();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    microphone.stop();
  }, []);

  async function startRecording() {
    setRecordingError("");
    setSpeechError("");
    setIsTranscribing(false);
    onAudioMemoChange(null);
    if (typeof MediaRecorder === "undefined") {
      setRecordingError("This browser cannot record an audio memo.");
      return;
    }
    const stream = await microphone.start();
    if (!stream) {
      setRecordingError(microphone.state === "denied"
        ? "Microphone access was denied. Check browser permissions and retry."
        : "The microphone could not start. Check browser permissions and input device.");
      return;
    }
    try {
      chunksRef.current = [];
      discardRef.current = false;
      baseTextRef.current = projectDescription.trim();
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (!discardRef.current && chunksRef.current.length > 0) {
          onAudioMemoChange(new Blob(chunksRef.current, { type: recorder.mimeType || chunksRef.current[0]?.type || "application/octet-stream" }));
        }
        recorderRef.current = null;
        setIsRecording(false);
        if (!recognitionRef.current) microphone.stop();
      };
      recorder.start();
      setIsRecording(true);
      const SpeechRecognition = getWebSpeechConstructor();
      if (!SpeechRecognition) {
        setSpeechError("Speech recognition is unavailable in this browser. Type the project prompt below.");
        return;
      }
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        if (discardRef.current) return;
        const parts: string[] = [];
        for (let index = 0; index < event.results.length; index += 1) {
          const phrase = event.results[index][0]?.transcript.trim();
          if (phrase) parts.push(phrase);
        }
        const spokenText = parts.join(" ").trim();
        if (spokenText) {
          updateDescription([baseTextRef.current, spokenText].filter(Boolean).join("\n\n"));
          setSelectedIdeaId("");
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setSpeechError("Browser speech recognition permission was denied. Type or edit the prompt instead.");
        } else if (event.error === "no-speech") {
          setSpeechError("No speech was detected. Try again or type the prompt.");
        } else {
          setSpeechError("Browser speech recognition stopped. Your typed prompt remains available.");
        }
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        setIsTranscribing(false);
        if (recorderRef.current?.state !== "recording") microphone.stop();
      };
      try {
        recognition.start();
        setIsTranscribing(true);
      } catch {
        recognitionRef.current = null;
        setSpeechError("Browser speech recognition could not start. Type the project prompt instead.");
      }
    } catch {
      microphone.stop();
      setRecordingError("Audio recording could not start in this browser.");
    }
  }

  function stopRecording(discard: boolean) {
    discardRef.current = discard;
    const recognition = recognitionRef.current;
    if (recognition) {
      if (discard) recognition.abort();
      else recognition.stop();
    }
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    if (discard) {
      onAudioMemoChange(null);
      updateDescription(baseTextRef.current);
      microphone.stop();
    }
    if (!recognition && recorderRef.current?.state !== "recording") microphone.stop();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hasDescription || isGenerating || microphoneBusy || isRecording || isTranscribing) return;
    const description = projectDescription.trim();
    const nextSurvey: TeamSurvey = {
      ...survey,
      outcome: description,
      outcomeDoneWhen: survey.outcomeDoneWhen.trim() || "A teammate can demonstrate the described outcome through one working end-to-end path.",
    };
    onSurveyChange(nextSurvey);
    onGenerate({ projectDescription: description, survey: nextSurvey });
  }

  function updateSurvey(update: Partial<TeamSurvey>) {
    onSurveyChange({ ...survey, ...update });
  }

  function updateDescription(value: string) {
    onDescriptionChange(value);
    onSurveyChange({ ...survey, outcome: value });
  }

  return (
    <section className="flow-panel project-prompt" aria-labelledby="project-prompt-title">
      <header className="flow-heading">
        <div className="flow-heading__copy">
          <p className="step-kicker"><span className="step-marker">03</span> Setup · 3 of 3</p>
          <h1 id="project-prompt-title">What should your team build?</h1>
          <p className="flow-intro">Describe what should work and what already exists.</p>
        </div>
      </header>

      <form className="project-prompt-form" onSubmit={submit}>
        <label className="project-prompt-label" htmlFor="project-description">
          <span>Describe a result someone can try.</span>
          <textarea
            id="project-description"
            rows={7}
            maxLength={2400}
            value={projectDescription}
            onChange={(event) => {
              setSelectedIdeaId("");
              updateDescription(event.target.value);
            }}
            placeholder="What should work by the deadline? What already exists?"
            aria-describedby="project-prompt-help project-prompt-count"
            readOnly={isRecording}
            required
          />
        </label>
        <div className="project-prompt-utility">
          <p id="project-prompt-help">One testable outcome.</p>
          <span id="project-prompt-count">{projectDescription.length} / 2,400</span>
        </div>

        <div className="project-idea-actions">
          <button className="button button--quiet" type="button" onClick={onSuggestIdeas} disabled={isSuggestingIdeas || isGenerating}>
            {isSuggestingIdeas ? "Suggesting projects" : "Suggest 5 projects"}
          </button>
          <p className="project-idea-status" role="status" aria-live="polite">
            {ideaError || (ideas.length === 5 ? "Choose an idea to fill the prompt." : "Suggestions use confirmed event facts and team roles.")}
          </p>
        </div>

        {ideas.length === 5 && (
          <fieldset className="project-idea-list">
            <legend>Five project ideas</legend>
            {ideas.map((idea) => {
              const selected = selectedIdeaId === idea.id;
              return (
                <label className={`project-idea-option${selected ? " is-selected" : ""}`} key={idea.id}>
                  <input
                    type="radio"
                    name="project-idea"
                    value={idea.id}
                    checked={selected}
                    onChange={() => {
                      setSelectedIdeaId(idea.id);
                      updateDescription(`${idea.title}\n\n${idea.description}\n\nTeam fit: ${idea.teamFit}\nDemo: ${idea.demonstration}`);
                    }}
                  />
                  <span className="project-idea-option__content">
                    <strong>{idea.title}</strong>
                    <span>{idea.description}</span>
                    <small>Team fit · {idea.teamFit}</small>
                    <small>Demo · {idea.demonstration}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}

        <div className="voice-input-line">
          <VoiceBeam
            className="voice-beam-control"
            stream={microphone.stream}
            active={isRecording}
            type="pill"
            look="lines"
            linePattern="rows"
            lineWidth={0.7}
            lineGap={1.2}
            colorVariant="mono"
            theme="dark"
            staticColors
            strength={0.35}
            idle={0}
            flow={0}
            bend={0}
            distortion={0}
            bandStrength={0}
          >
            <button
              className="button button--quiet voice-input-button"
              type="button"
              onClick={() => isRecording ? stopRecording(false) : void startRecording()}
              disabled={!microphone.supported || microphoneBusy || isGenerating || (isTranscribing && !isRecording) || (!isRecording && typeof MediaRecorder === "undefined")}
              aria-pressed={isRecording}
              aria-describedby="voice-input-status"
            >
              {microphoneBusy ? "Requesting microphone" : isRecording ? "Stop voice input" : isTranscribing ? "Finishing transcript" : getWebSpeechConstructor() ? "Start voice input" : "Record audio memo"}
            </button>
          </VoiceBeam>
          {isRecording && (
            <button className="button button--quiet" type="button" onClick={() => stopRecording(true)}>Discard capture</button>
          )}
          {audioMemo && !isRecording && (
            <>
              <audio className="voice-memo-player" controls src={audioUrl} aria-label="Listen to saved voice memo">Audio memo playback is unavailable.</audio>
              <button className="button button--quiet" type="button" onClick={() => onAudioMemoChange(null)}>Discard memo</button>
            </>
          )}
          <span className="voice-input-note">Browser speech recognition may use its service. Only edited text goes to planning.</span>
        </div>
        <p className="voice-input-status" id="voice-input-status" role="status" aria-live="polite">
          {recordingError || speechError || (microphone.state === "denied"
            ? "Microphone access was denied. Check browser permissions and retry."
            : microphone.state === "unsupported" || typeof MediaRecorder === "undefined"
              ? "Audio recording is unavailable in this browser."
            : isRecording
                ? isTranscribing
                  ? "Listening. Your draft appears in the prompt; stop to edit it."
                  : "Recording a local memo. Speech recognition is unavailable; type the prompt instead."
                : audioMemo
                  ? "Voice memo saved locally. Review the editable text before creating the plan."
                  : getWebSpeechConstructor()
                    ? "Start voice input for an editable transcript. You can also type."
                    : "Speech recognition is unavailable. Use the typed prompt; audio remains local.")}
        </p>

        <details className="project-optional-details" open={!modelReady || undefined}>
          <summary>Project details and model</summary>
          <div className="project-optional-fields">
            <label className="text-field" htmlFor="prompt-project-name">
              <span>Project name</span>
              <input
                id="prompt-project-name"
                type="text"
                value={survey.projectName}
                maxLength={100}
                onChange={(event) => updateSurvey({ projectName: event.target.value })}
                autoComplete="off"
              />
            </label>
            <label className="text-field project-model-field" htmlFor="prompt-planning-model">
              <span>Planning model</span>
              <select id="prompt-planning-model" value={selectedModel} onChange={(event) => onModelChange(event.target.value)} required>
                <option value="">Choose a listed model</option>
                {models.map((model) => <option value={model.slug} key={model.slug}>{model.displayName}{model.slug === recommendedModelSlug ? " · Recommended" : ""}</option>)}
              </select>
              <small className="model-help" role="status">{modelMessage || (models.length === 0 ? "No account-listed model is available." : "Only models returned for your account are shown.")}</small>
            </label>
          </div>
        </details>

        <p className="model-selection-note" role="status">
          {modelReady
            ? `Planning model · ${models.find((model) => model.slug === selectedModel)?.displayName}`
            : "Choose a listed planning model in project details to continue."}
        </p>

        <footer className="intake-actions">
          <button className="button button--quiet" type="button" onClick={onBack}>Back</button>
          <button className="button button--primary" type="submit" disabled={!hasDescription || !modelReady || isGenerating || microphoneBusy || isRecording || isTranscribing}>
            {isGenerating ? "Creating plan" : "Create sprint plan"}
          </button>
        </footer>
      </form>
    </section>
  );
}
