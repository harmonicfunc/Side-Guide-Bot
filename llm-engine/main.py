import os
from langchain_anthropic import ChatAnthropic
from langchain_sambanova import ChatSambaNovaCloud, SambaNovaCloudEmbeddings
from typing import List, Optional, TypedDict, Annotated, Sequence
from langchain_core.messages import BaseMessage, AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, END
from langchain_chroma import Chroma
from langchain_community.document_loaders import JSONLoader
from langchain.text_splitter import RecursiveCharacterTextSplitter

from dotenv import load_dotenv

#loading environment variables
load_dotenv()  # Loads from .env file into os.environ

api_key = os.getenv("SAMBANOVA_API_KEY")

llm = ChatSambaNovaCloud(
    model="Meta-Llama-3.3-70B-Instruct",
    temperature=0.1,
)

###### Example way of invoking the llm ###################

# response = llm.invoke("Do you have reasoning capabilities? Be more elaborate")
# print(response.content)

#####################################

#####Code snippet to visulaize the langgraph structure#################

# from IPython.display import Image, display

# try:
#     display(Image(graph.get_graph().draw_mermaid_png()))
# except Exception:
#     # This requires some extra dependencies and is optional
#     pass

################################################

embeddings = SambaNovaCloudEmbeddings(
    model="E5-Mistral-7B-Instruct"
)

json_path = "/home/alok/work/Side-Guide-Bot/Side-Guide-Bot/llm-engine/selectors.json"

json_loader = JSONLoader(
    file_path=json_path,
    jq_schema=".[]",
    text_content=False,
)

# Checks if the json is there
try:
    json_dump = json_loader.load()
    # print(f"PDF has been loaded and has {len(json_dump)} pages")
except Exception as e:
    print(f"Error loading PDF: {e}")
    raise

# Chunking Process
text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)

pages_split = text_splitter.split_documents(json_dump) # We now apply this to our pages

persist_directory = r"/home/alok/work/Side-Guide-Bot/Side-Guide-Bot"
collection_name = "json_collection"

# If our collection does not exist in the directory, we create using the os command
if not os.path.exists(persist_directory):
    os.makedirs(persist_directory)


# Safety measure I have put for debugging purposes :)
if not os.path.exists(json_path):
    raise FileNotFoundError(f"JSON file not found: {json_path}")

try:
    # Here, we actually create the chroma database using our embeddigns model
    vectorstore = Chroma.from_documents(
        documents=pages_split,
        embedding=embeddings,
        persist_directory=persist_directory,
        collection_name=collection_name
    )
    print(f"Created ChromaDB vector store!")
    
except Exception as e:
    print(f"Error setting up ChromaDB: {str(e)}")
    raise

# Now we create our retriever 
retriever = vectorstore.as_retriever(
    search_type="similarity",
    search_kwargs={"k": 3} # K is the amount of chunks to return
)

docs = retriever.invoke("Sign Up")
print(docs)

# class AgentState(TypedDict):
#     """Agent state, which includes the current state of the graph and the current node."""

#     'message': List[]


